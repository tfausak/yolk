'use strict';

// imports //

const { spawn } = require('child_process');
const { URI } = require('vscode-uri');
const vscode = require('vscode-languageserver');

// constants //

const DESIRED_COMPLETIONS = 10; // count
const POLL_INTERVAL = 10; // milliseconds
const GHC_SEVERITY_ERROR = 'SevError';
const GHC_SEVERITY_WARNING = 'SevWarning';
const PROMPT = `{- yolk ${Math.random().toFixed(4).substring(2)} -}`;

// globals //

const connection = vscode.createConnection();
const diagnostics = {};
const documents = {};
const ghciQueue = [];
let ghciStdout = '';

// diagnostic stuff //

const parseJson = (string) => {
  try {
    return JSON.parse(string);
  } catch (_error) {
    return null;
  }
};

// In order to avoid reporting the same diagnostics multiple times, we have to
// give each diagnostic a deterministic key. Note that this doesn't include any
// file information because the diagnostics are already grouped by file.
const toDiagnosticKey = (json) => [
  json.span.startLine,
  json.span.startCol,
  json.span.endLine,
  json.span.endCol,
  json.severity,
  json.reason,
].join('-');

const toDiagnosticRange = (json) => ({
  end: {
    character: json.span.endCol - 1,
    line: json.span.endLine - 1,
  },
  start: {
    character: json.span.startCol - 1,
    line: json.span.startLine - 1,
  },
});

const toDiagnosticSeverity = (json) => {
  // GHC reports deferred errors as warnings, but we want to show them to the
  // user as errors.
  if (json.reason && json.reason.startsWith('Opt_WarnDeferred')) {
    return vscode.DiagnosticSeverity.Error;
  }

  switch (json.severity) {
    case GHC_SEVERITY_ERROR: return vscode.DiagnosticSeverity.Error;
    case GHC_SEVERITY_WARNING: return vscode.DiagnosticSeverity.Warning;
    default: return vscode.DiagnosticSeverity.Information;
  }
};

const toDiagnosticValue = (json) => ({
  // These codes come from GHC, but they don't match the warning names that
  // control them. For example, an unused import says `Opt_WarnUnusedImports`
  // even though the flag is `-Wunused-imports`.
  code: json.reason,
  // These messages contain a lot of extra information. Some of it is useful
  // and should be parsed, like valid hole fits. Some of it is useless and
  // should be removed, like positional information. Some of it is
  // questionable, like relevant bindings.
  message: json.doc,
  range: toDiagnosticRange(json),
  severity: toDiagnosticSeverity(json),
  // It's not clear if the source should be the compiler (`ghc`) or the
  // extension (`yolk`).
  source: 'ghc',
});

const parseDiagnostics = (stdout) => {
  const result = [];
  let buffer = stdout;

  for (;;) {
    const index = buffer.indexOf('\n');
    if (index === -1) {
      break;
    }

    const line = buffer.substring(0, index);
    buffer = buffer.substring(index + 1);

    const json = parseJson(line);
    if (json && json.span && json.span.file !== '<interactive>') {
      result.push(json);
    } else {
      connection.console.info(line);
    }
  }

  return result;
};

const addDiagnostic = (json) => {
  const file = URI.file(json.span.file);
  if (!Object.prototype.hasOwnProperty.call(diagnostics, file)) {
    diagnostics[file] = {};
  }
  diagnostics[file][toDiagnosticKey(json)] = toDiagnosticValue(json);
};

const clearDiagnostics = () =>
  Object.keys(diagnostics).forEach((file) => {
    // Note that we want to keep the key around rather than deleting it. If we
    // deleted the key and the file had no new diagnostics, we wouldn't send
    // anything to the client. That means the client would assume that the old
    // diagnostics were still valid. We need to send an empty list of
    // diagnostics for the file instead.
    diagnostics[file] = {};
  });

const sendDiagnostics = () =>
  Object.keys(diagnostics).forEach((file) =>
    connection.sendDiagnostics({
      diagnostics: Object.values(diagnostics[file]),
      uri: file,
    }));

const handleDiagnostics = (buffer) => {
  parseDiagnostics(buffer).forEach(addDiagnostic);
  sendDiagnostics();
};

// ghci stuff //

const ghci = spawn(
  'stack',
  [
    // Separate from GHC, Stack tries to colorize its messages. We don't try to
    // parse Stack's output, so it doesn't really matter. But it's annoying to
    // see the ANSI escape codes in the debug output.
    '--color=never',
    // Explicitly setting the terminal width avoids a warning about `stty`.
    '--terminal-width=0',
    'ghci',
    '--ghc-options',
    [
      // This one is critical. Rather than trying to parse GHC's human-readable
      // output, we can get it to print out JSON instead. Note that the
      // messages themselves are still human readable. It's the metadata that
      // gets turned into structured JSON.
      '-ddump-json',
      // Deferring type errors turns them into warnings, which allows more
      // warnings to be reported when there are type errors.
      '-fdefer-type-errors',
      // We're not interested in actually building anything, just type
      // checking. This has the nice side effect of making things faster.
      '-fno-code',
      // Using multiple cores should be faster. Might need to actually
      // benchmark this, and maybe expose it as an option.
      '-j',
    ].join(' '),
  ]
);

ghci.stdout.on('data', (data) => {
  ghciStdout += data.toString();
});

ghci.stderr.on('data', (data) =>
  connection.console.warn(data.toString().trimEnd()));

ghci.on('close', (code) => {
  throw new Error(`GHCi closed with code ${code}!`);
});

const processJob = (job, callback) =>
  ghci.stdin.write(`${job.command}\n`, (error) => {
    if (error) {
      throw error;
    }

    const poll = () => {
      const index = ghciStdout.indexOf(PROMPT);
      if (index === -1) {
        return setTimeout(poll, POLL_INTERVAL);
      }

      const buffer = ghciStdout.substring(0, index);
      ghciStdout = '';
      job.callback(buffer);
      return callback();
    };

    poll();
  });

const processGhci = () => {
  const job = ghciQueue.shift();

  if (job) {
    processJob(job, processGhci);
  } else {
    setTimeout(processGhci, POLL_INTERVAL);
  }
};

processGhci();

const tellGhci = (command, callback) => ghciQueue.push({ callback, command });

// We are using GHCi as a server by sending messages to it and parsing
// responses. We are using the prompt to let us know when GHCi has finished
// processing a message. Therefore setting the prompt must be the very first
// message we send to GHCi, otherwise it won't be able to detect when
// processing is finished.
tellGhci(`:set prompt "${PROMPT}"`, handleDiagnostics);

// This option enables collecting type information, which makes it possible to
// use commands like `:type-at`.
tellGhci(':set +c', handleDiagnostics);

// language server //

connection.onInitialize(() => ({
  capabilities: {
    completionProvider: {
      resolveProvider: true,
    },
    textDocumentSync: {
      // This should really use the incremental syncing strategy. Unfortunately
      // it's not immediately apparent to me how to actually keep the documents
      // in sync. I'm sure the VSCode API has something for it, but I couldn't
      // find it.
      change: vscode.TextDocumentSyncKind.Full,
      openClose: true,
      save: true,
    },
  },
}));

connection.onCompletion((params) => {
  const token = documents[params.textDocument.uri][params.position.line]
    .substring(0, params.position.character)
    .split(/[(),;[\]`{} \t]+/)
    .pop();
  return new Promise((resolve) =>
    tellGhci(`:complete repl ${DESIRED_COMPLETIONS} "${token}"`, (buffer) => {
      const [header, ...lines] = buffer.trimEnd().split(/\r?\n/);
      const [_count, total, rawPrefix] = header.split(' ');
      const prefix = JSON.parse(rawPrefix);
      resolve({
        isIncomplete: total > DESIRED_COMPLETIONS,
        items: lines.map((line) => ({
          label: `${prefix}${JSON.parse(line)}`,
        })),
      });
    }));
});

connection.onCompletionResolve((params) => {
  switch (params.insertTextFormat) {
    case vscode.InsertTextFormat.PlainText:
      return new Promise((resolve) =>
        tellGhci(`:info ${params.label}`, (detail) =>
          tellGhci(`:doc ${params.label}`, (documentation) =>
            resolve({ detail, documentation, label: params.label }))));
    default:
      return params;
  }
});

connection.onDidChangeTextDocument((params) =>
  params.contentChanges.forEach((change) => {
    documents[params.textDocument.uri] = change.text.split(/\r?\n/);
  }));

connection.onDidCloseTextDocument((params) => {
  delete documents[params.textDocument.uri];
});

connection.onDidOpenTextDocument((params) => {
  documents[params.textDocument.uri] = params.textDocument.text.split(/\r?\n/);
});

connection.onDidSaveTextDocument(() => {
  clearDiagnostics();
  sendDiagnostics();
  tellGhci(':reload', handleDiagnostics);
});

connection.listen();

// By default VSCode won't show console output unless there's been an error. By
// logging an error on startup, we can be sure that all console messages are
// seen. This is only useful for development and should be removed later.
connection.console.error('Hello from Yolk!');
