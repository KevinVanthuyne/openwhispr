const test = require("node:test");
const assert = require("node:assert/strict");

const LlamaServerManager = require("../../src/helpers/llamaServer.js");

const MINUTE = 60 * 1000;

// The idle callback awaits the server's /slots answer before it decides.
const settle = () => new Promise(setImmediate);

// A manager whose spawn is stubbed at the _doStart boundary but still arms the
// idle timer the way a real start does, whose /slots answer is scripted, and
// whose stop is recorded.
function makeManager() {
  const manager = new LlamaServerManager();
  const stops = [];
  manager.processing = false;
  manager._requestJson = async (path) =>
    path === "/slots" ? [{ is_processing: false }, { is_processing: manager.processing }] : null;
  manager._doStart = async (modelPath, options = {}) => {
    manager.ready = true;
    manager.modelPath = modelPath;
    manager.draftModelPath = options.draftModelPath || null;
    manager.resetIdleTimer();
  };
  manager.stop = async () => {
    stops.push(Date.now());
    manager.clearIdleTimer();
  };
  return { manager, stops };
}

// Streaming chat (the Voice Assistant panel, typed chat) asks for the running
// server before every turn and then talks to its port directly, so that ask is
// the only activity the server sees. Before this, an active conversation was
// stopped five minutes after the server first started.
test("asking for the already running server postpones the idle stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();

  await manager.start("/models/main.gguf");
  t.mock.timers.tick(4 * MINUTE);
  await manager.start("/models/main.gguf");
  t.mock.timers.tick(4 * MINUTE);
  await settle();

  assert.equal(stops.length, 0, "an active server must not idle out");

  t.mock.timers.tick(1 * MINUTE + 1);
  await settle();
  assert.equal(stops.length, 1, "it still stops once really idle");
});

// A single streamed answer can outlast the timeout with no new request.
test("a server still generating an answer is not stopped mid-stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();

  await manager.start("/models/main.gguf");
  manager.processing = true;
  t.mock.timers.tick(5 * MINUTE + 1);
  await settle();
  assert.equal(stops.length, 0, "a busy slot must postpone the stop");

  manager.processing = false;
  t.mock.timers.tick(5 * MINUTE + 1);
  await settle();
  assert.equal(stops.length, 1, "it stops once the answer is done");
});

test("a server that cannot answer /slots is stopped as before", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  manager._requestJson = async () => null;

  await manager.start("/models/main.gguf");
  t.mock.timers.tick(5 * MINUTE + 1);
  await settle();

  assert.equal(stops.length, 1);
});

test("a request that arrives while /slots is checked keeps the server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  let answerSlots;
  manager._requestJson = () =>
    new Promise((resolve) => {
      answerSlots = resolve;
    });

  await manager.start("/models/main.gguf");
  t.mock.timers.tick(5 * MINUTE + 1);
  await manager.start("/models/main.gguf");
  answerSlots([{ is_processing: false }]);
  await settle();

  assert.equal(stops.length, 0, "the newer request's timer owns the decision now");
});

// A manager whose start resolves only when the test says so, recording each
// model it was asked to load.
function makeSlowManager() {
  const { manager } = makeManager();
  const loads = [];
  manager._doStart = (modelPath, options = {}) =>
    new Promise((resolve) => {
      loads.push({
        modelPath,
        finish: () => {
          manager.ready = true;
          manager.modelPath = modelPath;
          manager.draftModelPath = options.draftModelPath || null;
          resolve();
        },
      });
    });
  return { manager, loads };
}

test("a request for the model already loading joins that load", async () => {
  const { manager, loads } = makeSlowManager();

  const first = manager.start("/models/main.gguf");
  const second = manager.start("/models/main.gguf");
  loads[0].finish();
  await Promise.all([first, second]);

  assert.equal(loads.length, 1);
});

// Joining it would hand the request a server holding the wrong model.
test("a request for another model waits for the load under way, then loads its own", async () => {
  const { manager, loads } = makeSlowManager();

  const first = manager.start("/models/main.gguf");
  const second = manager.start("/models/other.gguf");
  loads[0].finish();
  await first;
  await settle();
  assert.equal(loads.length, 2, "the second model starts once the first load is done");
  assert.equal(loads[1].modelPath, "/models/other.gguf");

  loads[1].finish();
  await second;
  assert.equal(manager.modelPath, "/models/other.gguf");
});

test("a request needing a larger context does not join a smaller load", async () => {
  const { manager, loads } = makeSlowManager();

  const first = manager.start("/models/main.gguf", { contextSize: 16384 });
  const second = manager.start("/models/main.gguf", { contextSize: 32768 });
  loads[0].finish();
  await first;
  await settle();
  assert.equal(loads.length, 2);

  loads[1].finish();
  await second;
  assert.equal(manager.contextSize, 32768);
});
