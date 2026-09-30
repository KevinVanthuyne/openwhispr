const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const listeners = new Map();

const MODEL = "qwen3.5-4b-q4_k_m";
const modelManager = {
  currentServerModelId: null,
  stops: 0,
  status: { running: true, starting: false },
  prewarms: [],
  getServerStatus: () => modelManager.status,
  prewarmServer: async (modelId) => {
    modelManager.prewarms.push(modelId);
    return true;
  },
  stopServer: async () => {
    modelManager.stops += 1;
  },
};

const electronStub = {
  app: {
    getPath: () => "",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener),
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }

    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }
  if (parent?.filename === handlersModulePath && request === "./modelManagerBridge") {
    return { default: modelManager };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

const dictationRenderer = {};
let target;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = { signedIn: false, envKeys: [] };
  target._syncStartupEnv = (setVars, clearVars) => {
    target.envKeys = [...Object.keys(setVars), ...clearVars];
  };
  target._hasActiveAccountScope = () => target.signedIn;
  target._prewarmDictationModel = Ctor.prototype._prewarmDictationModel;
  target.windowManager = {
    mainWindow: { isDestroyed: () => false, webContents: dictationRenderer },
    setDictationLifecycleState: () => {},
  };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  assert.ok(handlers.get("sync-startup-preferences"), "sync handler must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

function sync({ loaded, signedIn = false, policySettled = true, ...scopes }) {
  modelManager.currentServerModelId = loaded;
  modelManager.stops = 0;
  target.signedIn = signedIn;
  return handlers.get("sync-startup-preferences")(
    {},
    {
      useLocalWhisper: false,
      useCleanupModel: true,
      cleanupMode: "openwhispr",
      useDictationAgent: true,
      dictationAgentMode: "openwhispr",
      noteFormattingMode: "openwhispr",
      chatAgentMode: "openwhispr",
      useDictationTranslation: false,
      translationMode: "openwhispr",
      policySettled,
      ...scopes,
    }
  );
}

test("a window sync keeps the server while another scope still needs its model", async () => {
  await sync({ loaded: MODEL, chatAgentMode: "local", chatAgentModel: MODEL });
  assert.equal(modelManager.stops, 0);
});

test("a window sync stops the server once no scope needs its model", async () => {
  await sync({ loaded: MODEL, chatAgentMode: "local", chatAgentModel: "gemma-4-e2b" });
  assert.equal(modelManager.stops, 1);
});

test("a signed-in window waits for its workspace policy before touching the server", async () => {
  await sync({ loaded: MODEL, signedIn: true, policySettled: false });
  assert.equal(modelManager.stops, 0);
  assert.equal(target.envKeys.includes("CLEANUP_PROVIDER"), false, "no pre-warm change either");

  await sync({ loaded: MODEL, signedIn: true, policySettled: true });
  assert.equal(modelManager.stops, 1);
});

test("signed out, the policy never loads, so an unresolved policy does not block the stop", async () => {
  await sync({ loaded: MODEL, signedIn: false, policySettled: false });
  assert.equal(modelManager.stops, 1);
});

const ENV_KEYS = [
  "CLEANUP_PROVIDER",
  "LOCAL_CLEANUP_MODEL",
  "DICTATION_AGENT_PROVIDER",
  "LOCAL_DICTATION_AGENT_MODEL",
];

// Reports a dictation lifecycle state with a local cleanup model configured
// and returns the models the server was asked to load.
function report(state, { sender = dictationRenderer, inputKind = "dictation", ...server } = {}) {
  const saved = ENV_KEYS.map((key) => process.env[key]);
  process.env.CLEANUP_PROVIDER = "local";
  process.env.LOCAL_CLEANUP_MODEL = MODEL;
  delete process.env.DICTATION_AGENT_PROVIDER;
  delete process.env.LOCAL_DICTATION_AGENT_MODEL;
  modelManager.prewarms = [];
  modelManager.currentServerModelId = server.loaded ?? null;
  modelManager.status = { running: !!server.running, starting: !!server.starting };
  try {
    listeners.get("dictation-lifecycle-state-changed")({ sender }, state, inputKind);
  } finally {
    ENV_KEYS.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    modelManager.status = { running: true, starting: false };
  }
  return modelManager.prewarms;
}

// The idle unload stops the server but leaves the id of the model it held.
test("a recording that starts after an idle unload loads the cleanup model", () => {
  assert.deepEqual(report("recording", { loaded: MODEL, running: false }), [MODEL]);
});

test("only a recording loads the model, not a key press that may be cancelled", () => {
  assert.deepEqual(report("preparing"), []);
  assert.deepEqual(report("processing"), []);
});

test("a recording leaves a server that holds another model alone", () => {
  assert.deepEqual(report("recording", { loaded: "gemma-4-e2b", running: true }), []);
});

test("a recording leaves a server that is already loading alone", () => {
  assert.deepEqual(report("recording", { starting: true }), []);
});

test("a voice assistant recording with a cloud agent loads nothing", () => {
  assert.deepEqual(report("recording", { inputKind: "assistant" }), []);
});

test("a lifecycle report from another window loads nothing", () => {
  assert.deepEqual(report("recording", { sender: {} }), []);
});
