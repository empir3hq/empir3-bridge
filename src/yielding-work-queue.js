'use strict';

function createYieldingWorkQueue({ concurrency = 4, schedule = setImmediate } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error('concurrency must be an integer between 1 and 64');
  }
  const pending = [];
  let active = 0;

  function drain() {
    while (active < concurrency && pending.length > 0) {
      const item = pending.shift();
      active += 1;
      schedule(async () => {
        try {
          item.resolve(await item.task());
        } catch (error) {
          item.reject(error);
        } finally {
          active -= 1;
          drain();
        }
      });
    }
  }

  function enqueue(task) {
    if (typeof task !== 'function') return Promise.reject(new Error('task must be a function'));
    return new Promise((resolve, reject) => {
      pending.push({ task, resolve, reject });
      drain();
    });
  }

  function status() {
    return { active, pending: pending.length, concurrency };
  }

  return { enqueue, status };
}

module.exports = { createYieldingWorkQueue };
