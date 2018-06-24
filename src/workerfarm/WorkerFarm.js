const {EventEmitter} = require('events');
const os = require('os');
const errorUtils = require('./errorUtils');
const Worker = require('./Worker');

let shared = null;
class WorkerFarm extends EventEmitter {
  constructor(options, farmOptions = {}) {
    super();
    this.options = Object.assign(
      {
        maxConcurrentWorkers: WorkerFarm.getNumWorkers(),
        maxConcurrentCallsPerWorker: 5,
        forcedKillTime: 500,
        warmWorkers: true,
        useLocalWorker: true,
        workerPath: '../worker'
      },
      farmOptions
    );

    this.warmWorkers = 0;
    this.workers = new Map();
    this.callQueue = [];

    this.localWorker = require(this.options.workerPath);
    this.run = this.mkhandle('run');

    this.init(options);
  }

  warmupWorker(method, args) {
    // Workers are not warmed up yet.
    // Send the job to a remote worker in the background,
    // but use the result from the local worker - it will be faster.
    let promise = this.addCall(method, [...args, true]);
    if (promise) {
      promise
        .then(() => {
          this.warmWorkers++;
          if (this.warmWorkers >= this.workers.size) {
            this.emit('warmedup');
          }
        })
        .catch(() => {});
    }
  }

  shouldStartRemoteWorkers() {
    return (
      this.options.maxConcurrentWorkers > 1 ||
      process.env.NODE_ENV === 'test' ||
      !this.options.useLocalWorker
    );
  }

  mkhandle(method) {
    return function(...args) {
      // Child process workers are slow to start (~600ms).
      // While we're waiting, just run on the main thread.
      // This significantly speeds up startup time.
      if (this.shouldUseRemoteWorkers()) {
        return this.addCall(method, [...args, false]);
      } else {
        if (this.options.warmWorkers && this.shouldStartRemoteWorkers()) {
          this.warmupWorker(method, args);
        }

        return this.localWorker[method](...args, false);
      }
    }.bind(this);
  }

  onError(error, worker) {
    // Handle ipc errors
    if (error.code === 'ERR_IPC_CHANNEL_CLOSED') {
      return this.stopWorker(worker);
    }
  }

  resetCalls(worker) {
    let doQueue = false;

    if (worker && worker.calls && worker.calls.size) {
      for (let call of worker.calls.values()) {
        call.retries++;
        this.callQueue.unshift(call);
        doQueue = true;
      }
    }
    worker.calls = null;

    if (doQueue) {
      this.processQueue();
    }
  }

  startChild() {
    let worker = new Worker(this.options);

    worker.fork(this.options.workerPath, this.bundlerOptions);

    worker.on('request', data => this.processRequest(data, worker));

    worker.on('ready', () => this.processQueue());
    worker.on('response', () => this.processQueue());

    worker.on('error', err => this.onError(err, worker));
    worker.once('exit', () => this.stopWorker(worker));

    this.workers.set(worker.id, worker);
  }

  async stopWorker(worker) {
    if (!worker.stopped) {
      this.resetCalls(worker);
      await worker.stop();
      this.workers.delete(worker.id);
    }
  }

  async processQueue() {
    if (this.ending || !this.callQueue.length) return;

    if (this.workers.size < this.options.maxConcurrentWorkers) {
      this.startChild();
    }

    for (let worker of this.workers.values()) {
      if (!this.callQueue.length) {
        break;
      }

      if (!worker.ready || worker.stopped) {
        continue;
      }

      if (worker.calls.size < this.options.maxConcurrentCallsPerWorker) {
        worker.call(this.callQueue.shift());
      }
    }
  }

  async processRequest(data, worker = false) {
    let result = {
      idx: data.idx,
      type: 'response'
    };

    let method = data.method;
    let args = data.args;
    let location = data.location;
    let awaitResponse = data.awaitResponse;

    if (!location) {
      throw new Error('Unknown request');
    }

    const mod = require(location);
    try {
      let func;
      if (method) {
        func = mod[method];
      } else {
        func = mod;
      }
      result.contentType = 'data';
      result.content = await func(...args);
    } catch (e) {
      result.contentType = 'error';
      result.content = errorUtils.errorToJson(e);
    }

    if (awaitResponse) {
      if (worker) {
        worker.send(result);
      } else {
        return result;
      }
    }
  }

  addCall(method, args) {
    if (this.ending) return; // don't add anything new to the queue

    return new Promise((resolve, reject) => {
      this.callQueue.push({
        method,
        args: args,
        retries: 0,
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  async end() {
    this.ending = true;
    await Promise.all(
      Array.from(this.workers.values()).map(worker => this.stopWorker(worker))
    );
    this.ending = false;
    shared = null;
  }

  init(bundlerOptions) {
    this.bundlerOptions = bundlerOptions;

    if (this.shouldStartRemoteWorkers()) {
      this.persistBundlerOptions();
    }

    this.localWorker.init(bundlerOptions);
    this.startMaxWorkers();
  }

  persistBundlerOptions() {
    for (let worker of this.workers.values()) {
      worker.init(this.bundlerOptions);
    }
  }

  startMaxWorkers() {
    // Starts workers untill the maximum is reached
    if (this.workers.size < this.options.maxConcurrentWorkers) {
      for (
        let i = 0;
        i < this.options.maxConcurrentWorkers - this.workers.size;
        i++
      ) {
        this.startChild();
      }
    }
  }

  shouldUseRemoteWorkers() {
    return (
      !this.options.useLocalWorker ||
      (this.warmWorkers >= this.workers.size || !this.options.warmWorkers)
    );
  }

  static getShared(options) {
    if (!shared) {
      shared = new WorkerFarm(options);
    } else if (options) {
      shared.init(options);
    }

    return shared;
  }

  static getNumWorkers() {
    if (process.env.PARCEL_WORKERS) {
      return parseInt(process.env.PARCEL_WORKERS, 10);
    }

    let cores;
    try {
      cores = require('physical-cpu-count');
    } catch (err) {
      cores = os.cpus().length;
    }
    return cores || 1;
  }
}

module.exports = WorkerFarm;
