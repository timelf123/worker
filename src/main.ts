import { EventEmitter } from "events";
import { Notification, Pool, PoolClient } from "pg";
import { inspect } from "util";

import { defaults } from "./config";
import deferred from "./deferred";
import {
  makeWithPgClientFromClient,
  makeWithPgClientFromPool,
} from "./helpers";
import {
  Job,
  TaskList,
  Worker,
  WorkerEventMap,
  WorkerEvents,
  WorkerOptions,
  WorkerPool,
  WorkerPoolOptions,
} from "./interfaces";
import { processSharedOptions } from "./lib";
import { Logger } from "./logger";
import SIGNALS, { Signal } from "./signals";
import { failJobs } from "./sql/failJob";
import { resetLockedAt } from "./sql/resetLockedAt";
import { makeNewWorker } from "./worker";

const ENABLE_DANGEROUS_LOGS =
  process.env.GRAPHILE_ENABLE_DANGEROUS_LOGS === "1";

// Wait at most 60 seconds between connection attempts for LISTEN.
const MAX_DELAY = 60 * 1000;

const allWorkerPools: Array<WorkerPool> = [];

// Exported for testing only
export { allWorkerPools as _allWorkerPools };

/**
 * All pools share the same signal handlers, so we need to broadcast
 * gracefulShutdown to all the pools' events; we use this event emitter to
 * aggregate these requests.
 */
const _signalHandlersEventEmitter: WorkerEvents = new EventEmitter();

/**
 * Only register the signal handlers once _globally_.
 */
let _registeredSignalHandlers = false;

/**
 * Only trigger graceful shutdown once.
 */
let _shuttingDownGracefully = false;
let _shuttingDownForcefully = false;

let _registeredSignalHandlersCount = 0;

/**
 * This will register the signal handlers to make sure the worker shuts down
 * gracefully if it can. It will only register signal handlers once; even if
 * you call it multiple times it will always use the first logger it is passed,
 * future calls will register the events but take no further actions.
 */
function registerSignalHandlers(
  logger: Logger,
  events: WorkerEvents,
): () => void {
  if (_shuttingDownGracefully || _shuttingDownForcefully) {
    throw new Error(
      "System has already gone into shutdown, should not be spawning new workers now!",
    );
  }

  const gscb = (o: WorkerEventMap["gracefulShutdown"]) =>
    events.emit("gracefulShutdown", o);
  const fscb = (o: WorkerEventMap["forcefulShutdown"]) =>
    events.emit("forcefulShutdown", o);

  if (!_registeredSignalHandlers) {
    _reallyRegisterSignalHandlers(logger);
  }

  _registeredSignalHandlersCount++;
  _signalHandlersEventEmitter.on("gracefulShutdown", gscb);
  _signalHandlersEventEmitter.on("forcefulShutdown", fscb);
  return function release() {
    _signalHandlersEventEmitter.off("gracefulShutdown", gscb);
    _signalHandlersEventEmitter.off("forcefulShutdown", fscb);
    _registeredSignalHandlersCount--;
    if (_registeredSignalHandlersCount === 0) {
      _releaseSignalHandlers();
    }
  };
}

let _releaseSignalHandlers = () => void 0;

function _reallyRegisterSignalHandlers(logger: Logger) {
  const switchToForcefulHandler = () => {
    logger.debug(
      `Switching to forceful handler for termination signals (${SIGNALS.join(
        ", ",
      )}); another termination signal will force a fast (unsafe) shutdown`,
      { switchToForcefulHandlers: true },
    );
    for (const signal of SIGNALS) {
      process.on(signal, forcefulHandler);
      process.removeListener(signal, gracefulHandler);
    }
  };
  const removeForcefulHandler = () => {
    logger.debug(
      `Removed forceful handler for termination signals (${SIGNALS.join(
        ", ",
      )}); another termination signals will likely kill the process (unless you've registered other handlers)`,
      { unregisteringSignalHandlers: true },
    );
    for (const signal of SIGNALS) {
      process.removeListener(signal, forcefulHandler);
    }
  };

  const gracefulHandler = function (signal: Signal) {
    if (_shuttingDownGracefully) {
      logger.error(
        `Ignoring '${signal}' (graceful shutdown already in progress)`,
      );
      return;
    } else {
      _shuttingDownGracefully = true;
    }

    logger.error(
      `Received '${signal}'; attempting global graceful shutdown... (all termination signals will be ignored for the next 5 seconds)`,
    );
    const switchTimeout = setTimeout(switchToForcefulHandler, 5000);
    _signalHandlersEventEmitter.emit("gracefulShutdown", { signal });

    Promise.allSettled(
      allWorkerPools.map((pool) =>
        pool.gracefulShutdown(`Graceful worker shutdown due to ${signal}`),
      ),
    ).finally(() => {
      clearTimeout(switchTimeout);
      process.removeListener(signal, gracefulHandler);
      if (!_shuttingDownForcefully) {
        logger.error(
          `Global graceful shutdown complete; killing self via ${signal}`,
        );
        process.kill(process.pid, signal);
      }
    });
  };
  const forcefulHandler = function (signal: Signal) {
    if (_shuttingDownForcefully) {
      logger.error(
        `Ignoring '${signal}' (forceful shutdown already in progress)`,
      );
      return;
    } else {
      _shuttingDownForcefully = true;
    }

    logger.error(
      `Received '${signal}'; attempting global forceful shutdown... (all termination signals will be ignored for the next 5 seconds)`,
    );
    const removeTimeout = setTimeout(removeForcefulHandler, 5000);
    _signalHandlersEventEmitter.emit("forcefulShutdown", { signal });

    Promise.allSettled(
      allWorkerPools.map((pool) =>
        pool.forcefulShutdown(`Forced worker shutdown due to ${signal}`),
      ),
    ).finally(() => {
      removeForcefulHandler();
      clearTimeout(removeTimeout);
      logger.error(
        `Global forceful shutdown completed; killing self via ${signal}`,
      );
      process.kill(process.pid, signal);
    });
  };

  logger.debug(
    `Registering termination signal handlers (${SIGNALS.join(", ")})`,
    { registeringSignalHandlers: SIGNALS },
  );

  _registeredSignalHandlers = true;
  for (const signal of SIGNALS) {
    process.on(signal, gracefulHandler);
  }
  _releaseSignalHandlers = () => {
    if (_shuttingDownGracefully || _shuttingDownForcefully) {
      console.warn(`Not unregistering signal handlers as we're shutting down`);
      return;
    }

    _releaseSignalHandlers = () => void 0;
    for (const signal of SIGNALS) {
      process.off(signal, gracefulHandler);
    }
    _registeredSignalHandlers = false;
  };
}

export function runTaskList(
  options: WorkerPoolOptions,
  tasks: TaskList,
  pgPool: Pool,
): WorkerPool {
  const { logger, events } = processSharedOptions(options);
  if (ENABLE_DANGEROUS_LOGS) {
    logger.debug(`Worker pool options are ${inspect(options)}`, { options });
  }
  const { concurrency = defaults.concurrentJobs, noHandleSignals } = options;

  let unregisterSignalHandlers: (() => void) | undefined = undefined;
  if (!noHandleSignals) {
    // Clean up when certain signals occur
    unregisterSignalHandlers = registerSignalHandlers(logger, events);
  }

  const promise = deferred();
  const workers: Array<Worker> = [];

  let changeListener: {
    client: PoolClient;
    release: () => void;
  } | null = null;

  const unlistenForChanges = async () => {
    if (changeListener) {
      try {
        changeListener.release();
      } catch (e) {
        logger.error(
          `Error occurred whilst releasing listening client: ${e.message}`,
          { error: e },
        );
      }
    }
  };
  let active = true;
  let reconnectTimeout: NodeJS.Timeout | null = null;

  const compiledSharedOptions = processSharedOptions(options);
  const { minResetLockedInterval, maxResetLockedInterval } =
    compiledSharedOptions;

  const resetLockedDelay = () =>
    Math.ceil(
      minResetLockedInterval +
        Math.random() * (maxResetLockedInterval - minResetLockedInterval),
    );

  let resetLockedAtPromise: Promise<void> | undefined;

  const resetLocked = () => {
    resetLockedAtPromise = resetLockedAt(
      compiledSharedOptions,
      withPgClient,
    ).then(
      () => {
        resetLockedAtPromise = undefined;
        if (active) {
          const delay = resetLockedDelay();
          events.emit("resetLocked:success", { pool: this, delay });
          resetLockedTimeout = setTimeout(resetLocked, delay);
        } else {
          events.emit("resetLocked:success", { pool: this, delay: null });
        }
      },
      (e) => {
        resetLockedAtPromise = undefined;
        // TODO: push this error out via an event.
        if (active) {
          const delay = resetLockedDelay();
          events.emit("resetLocked:failure", { pool: this, error: e, delay });
          resetLockedTimeout = setTimeout(resetLocked, delay);
          logger.error(
            `Failed to reset locked; we'll try again in ${delay}ms`,
            {
              error: e,
            },
          );
        } else {
          events.emit("resetLocked:failure", {
            pool: this,
            error: e,
            delay: null,
          });
          logger.error(
            `Failed to reset locked, but we're shutting down so won't try again`,
            {
              error: e,
            },
          );
        }
      },
    );
    events.emit("resetLocked:started", { pool: this });
  };

  // Reset locked in the first 60 seconds, not immediately because we don't
  // want to cause a thundering herd.
  let resetLockedTimeout: NodeJS.Timeout | null = setTimeout(
    resetLocked,
    Math.random() * Math.min(60000, maxResetLockedInterval),
  );

  function deactivate() {
    if (active) {
      active = false;
      if (resetLockedTimeout) {
        clearTimeout(resetLockedTimeout);
        resetLockedTimeout = null;
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      events.emit("pool:release", { pool: this });
      unlistenForChanges();
    }
  }

  let terminated = false;
  function terminate() {
    if (!terminated) {
      terminated = true;
      const idx = allWorkerPools.indexOf(workerPool);
      allWorkerPools.splice(idx, 1);
      promise.resolve(resetLockedAtPromise);
      if (unregisterSignalHandlers) {
        unregisterSignalHandlers();
      }
    } else {
      logger.error(
        `Graphile Worker internal error: terminate() was called twice for worker pool. Ignoring second call; but this indicates a bug - please file an issue.`,
      );
    }
  }

  const abortController = new AbortController();
  const abortSignal = abortController.signal;

  // This is a representation of us that can be interacted with externally
  const workerPool: WorkerPool = {
    _shuttingDown: false,
    abortSignal,
    release: async () => {
      console.trace(
        "DEPRECATED: You are calling `workerPool.release()`; please use `workerPool.gracefulShutdown()` instead.",
      );
      return this.gracefulShutdown();
    },

    /**
     * Stop accepting jobs, and wait gracefully for the jobs that are in
     * progress to complete.
     */
    async gracefulShutdown(
      message = "Worker pool is shutting down gracefully",
    ) {
      if (workerPool._shuttingDown) {
        logger.error(
          `gracefulShutdown called when gracefulShutdown is already in progress`,
        );
        return;
      }
      workerPool._shuttingDown = true;

      const abortTimer = setTimeout(() => {
        abortController.abort();
      }, compiledSharedOptions.gracefulShutdownAbortTimeout);
      abortTimer.unref();

      events.emit("pool:gracefulShutdown", { pool: this, message });
      try {
        logger.debug(`Attempting graceful shutdown`);
        // Stop new jobs being added
        deactivate();

        // Remove all the workers - we're shutting them down manually
        const workerPromises = workers.map((worker) => worker.release());
        const workerReleaseResults = await Promise.allSettled(workerPromises);
        const jobsToRelease: Job[] = [];
        for (let i = 0; i < workerReleaseResults.length; i++) {
          const workerReleaseResult = workerReleaseResults[i];
          if (workerReleaseResult.status === "rejected") {
            const worker = workers[i];
            const job = worker.getActiveJob();
            events.emit("pool:gracefulShutdown:workerError", {
              pool: this,
              error: workerReleaseResult.reason,
              job,
            });
            logger.debug(
              `Cancelling worker ${worker.workerId} (job: ${
                job?.id ?? "none"
              }) failed`,
              {
                worker,
                job,
                reason: workerReleaseResult.reason,
              },
            );
            if (job) {
              jobsToRelease.push(job);
            }
          }
        }
        if (jobsToRelease.length > 0) {
          const workerIds = workers.map((worker) => worker.workerId);
          logger.debug(
            `Releasing the jobs ${jobsToRelease
              .map((j) => j.id)
              .join()} (workers: ${workerIds.join(", ")})`,
            {
              jobs: jobsToRelease,
              workerIds,
            },
          );
          const cancelledJobs = await failJobs(
            compiledSharedOptions,
            withPgClient,
            workerIds,
            jobsToRelease,
            message,
          );
          logger.debug(`Cancelled ${cancelledJobs.length} jobs`, {
            cancelledJobs,
          });
        }
        events.emit("pool:gracefulShutdown:complete", { pool: this });
        logger.debug("Graceful shutdown complete");
      } catch (e) {
        events.emit("pool:gracefulShutdown:error", { pool: this, error: e });
        logger.error(`Error occurred during graceful shutdown: ${e.message}`, {
          error: e,
        });
        return this.forcefulShutdown(e.message);
      }
      terminate();
    },

    /**
     * Stop accepting jobs and "fail" all currently running jobs.
     */
    async forcefulShutdown(message: string) {
      events.emit("pool:forcefulShutdown", { pool: this, message });
      try {
        logger.debug(`Attempting forceful shutdown`);
        // Stop new jobs being added
        deactivate();

        // Release all our workers' jobs
        const jobsInProgress: Array<Job> = workers
          .map((worker) => worker.getActiveJob())
          .filter((job): job is Job => !!job);

        // Remove all the workers - we're shutting them down manually
        const workerPromises = workers.map((worker) => worker.release());
        // Ignore the results, we're shutting down anyway
        Promise.allSettled(workerPromises);

        if (jobsInProgress.length > 0) {
          const workerIds = workers.map((worker) => worker.workerId);
          logger.debug(
            `Releasing the jobs ${jobsInProgress
              .map((j) => j.id)
              .join()} (workers: ${workerIds.join(", ")})`,
            {
              jobs: jobsInProgress,
              workerIds,
            },
          );
          const cancelledJobs = await failJobs(
            compiledSharedOptions,
            withPgClient,
            workerIds,
            jobsInProgress,
            message,
          );
          logger.debug(`Cancelled ${cancelledJobs.length} jobs`, {
            cancelledJobs,
          });
        } else {
          logger.debug("No active jobs to release");
        }
        events.emit("pool:forcefulShutdown:complete", { pool: this });
        logger.debug("Forceful shutdown complete");
      } catch (e) {
        events.emit("pool:forcefulShutdown:error", { pool: this, error: e });
        logger.error(`Error occurred during forceful shutdown: ${e.message}`, {
          error: e,
        });
      }
      terminate();
    },

    promise,
  };

  abortSignal.addEventListener("abort", () => {
    if (!workerPool._shuttingDown) {
      workerPool.gracefulShutdown();
    }
  });

  // Ensure that during a forced shutdown we get cleaned up too
  allWorkerPools.push(workerPool);
  events.emit("pool:create", { workerPool });

  let attempts = 0;
  const listenForChanges = (
    err: Error | undefined,
    client: PoolClient,
    releaseClient: () => void,
  ) => {
    if (!active) {
      // We were released, release this new client and abort
      releaseClient?.();
      return;
    }

    const reconnectWithExponentialBackoff = (err: Error) => {
      events.emit("pool:listen:error", { workerPool, client, error: err });

      attempts++;

      // When figuring the next delay we want exponential back-off, but we also
      // want to avoid the thundering herd problem. For now, we'll add some
      // randomness to it via the `jitter` variable, this variable is
      // deliberately weighted towards the higher end of the duration.
      const jitter = 0.5 + Math.sqrt(Math.random()) / 2;

      // Backoff (ms): 136, 370, 1005, 2730, 7421, 20172, 54832
      const delay = Math.ceil(
        jitter * Math.min(MAX_DELAY, 50 * Math.exp(attempts)),
      );

      logger.error(
        `Error with notify listener (trying again in ${delay}ms): ${err.message}`,
        { error: err },
      );

      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        events.emit("pool:listen:connecting", { workerPool, attempts });
        pgPool.connect(listenForChanges);
      }, delay);
    };

    if (err) {
      // Try again
      reconnectWithExponentialBackoff(err);
      return;
    }

    //----------------------------------------

    let errorHandled = false;
    function onErrorReleaseClientAndTryAgain(e: Error) {
      if (errorHandled) {
        return;
      }
      errorHandled = true;
      try {
        release();
      } catch (e) {
        logger.error(`Error occurred releasing client: ${e.stack}`, {
          error: e,
        });
      }

      reconnectWithExponentialBackoff(e);
    }

    function handleNotification(message: Notification) {
      if (changeListener?.client === client) {
        switch (message.channel) {
          case "jobs:insert": {
            // Find a worker that's available
            workers.some((worker) => worker.nudge());
            break;
          }
          case "jobs:migrate": {
            let payload: null | { migrationNumber?: number } = null;
            try {
              payload = message.payload ? JSON.parse(message.payload) : null;
            } catch (e) {
              /* noop */
            }
            console.warn(
              `Graphile Worker detected migration to database schema revision '${payload?.migrationNumber}'; it would be unsafe to continue, so shutting down...`,
            );
            process.exitCode = 54;
            workerPool.gracefulShutdown();
            break;
          }
          default: {
            console.warn(
              `Unhandled NOTIFY message on channel '${message.channel}'`,
            );
          }
        }
      }
    }

    function release() {
      changeListener = null;
      client.removeListener("error", onErrorReleaseClientAndTryAgain);
      client.removeListener("notification", handleNotification);
      client.query('UNLISTEN "jobs:insert"').catch(() => {
        /* ignore errors */
      });
      releaseClient();
    }

    // On error, release this client and try again
    client.on("error", onErrorReleaseClientAndTryAgain);

    //----------------------------------------

    events.emit("pool:listen:success", { workerPool, client });
    changeListener = { client, release };
    client.on("notification", handleNotification);

    // Subscribe to jobs:insert message
    client.query('LISTEN "jobs:insert"').then(() => {
      // Successful listen; reset attempts
      attempts = 0;
    }, onErrorReleaseClientAndTryAgain);
    client
      .query('LISTEN "jobs:migrate"')
      .then(null, onErrorReleaseClientAndTryAgain);

    const supportedTaskNames = Object.keys(tasks);

    logger.info(
      `Worker connected and looking for jobs... (task names: '${supportedTaskNames.join(
        "', '",
      )}')`,
    );
  };

  // Create a client dedicated to listening for new jobs.
  events.emit("pool:listen:connecting", { workerPool, attempts });
  pgPool.connect(listenForChanges);

  // Spawn our workers; they can share clients from the pool.
  const withPgClient = makeWithPgClientFromPool(pgPool);
  const workerOptions: WorkerOptions = { ...options, abortSignal };
  for (let i = 0; i < concurrency; i++) {
    workers.push(makeNewWorker(workerOptions, tasks, withPgClient));
  }

  // TODO: handle when a worker shuts down (spawn a new one)

  return workerPool;
}

export const runTaskListOnce = (
  options: WorkerOptions,
  tasks: TaskList,
  client: PoolClient,
) => {
  const withPgClient = makeWithPgClientFromClient(client);
  const compiledSharedOptions = processSharedOptions(options);
  const resetPromise = resetLockedAt(compiledSharedOptions, withPgClient);
  const finalPromise = resetPromise.then(() => {
    const worker = makeNewWorker(
      options,
      tasks,
      makeWithPgClientFromClient(client),
      false,
    );
    finalPromise.worker = worker;
    return worker.promise;
  }) as Promise<void> & { worker: Worker };
  return finalPromise;
};
