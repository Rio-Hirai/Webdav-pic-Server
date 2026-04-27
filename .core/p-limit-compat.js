function pLimit(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("Expected concurrency to be a positive integer");
  }

  const queue = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()();
    }
  };

  const run = async (fn, resolve, args) => {
    activeCount++;
    try {
      resolve(await fn(...args));
    } catch (error) {
      resolve(Promise.reject(error));
    } finally {
      next();
    }
  };

  const enqueue = (fn, resolve, args) => {
    queue.push(run.bind(undefined, fn, resolve, args));
    if (activeCount < concurrency && queue.length > 0) {
      queue.shift()();
    }
  };

  return (fn, ...args) =>
    new Promise((resolve) => {
      if (activeCount < concurrency) {
        run(fn, resolve, args);
      } else {
        enqueue(fn, resolve, args);
      }
    });
}

module.exports = pLimit;
