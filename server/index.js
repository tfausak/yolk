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
const TOKEN_SEPARATORS = new Set([
  '',
  ' ',
  '\t',
  ',',
  ';',
  '`',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
]);

// globals //

const connection = vscode.createConnection();
const diagnostics = {};
const documents = {};
const ghciQueue = [];
let ghciStderr = '';
let ghciStdout = '';

// helpers //

const isBlank = (string) => string.trim() === '';

const parseJson = (string) => {
  try {
    return JSON.parse(string);
  } catch (_error) {
    return null;
  }
};

const presence = (string) => {
  if (isBlank(string)) {
    return null;
  }
  return string;
};

// diagnostic stuff //

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
  // For some reason GHC doubles up some (but not all) path separators on
  // Windows. This may affect other operating systems; I need to check. This
  // may also be a bug in Stack or something else instead. I should get to the
  // bottom of it and report a bug.
  const file = URI.file(json.span.file.replace(/\\\\/g, '\\'));

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
    'exec',
    '--',
    'ghci',
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
  ]
);

ghci.stdout.on('data', (data) => {
  ghciStdout += data.toString();
});

ghci.stderr.on('data', (data) => {
  ghciStderr += data.toString();

  for (;;) {
    const index = ghciStderr.indexOf('\n');
    if (index === -1) {
      break;
    }

    const line = ghciStderr.substring(0, index);
    ghciStderr = ghciStderr.substring(index + 1);

    connection.console.warn(line.trimEnd());
  }
});

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
      ghciStdout = ghciStdout.substring(index + PROMPT.length);
      job.callback(buffer);

      job.finishedAt = new Date();
      const elapsed = job.finishedAt - job.startedAt;
      connection.console.log(`finished ${job.command} in ${elapsed} ms`);
      return callback();
    };

    poll();
  });

const processGhci = () => {
  const job = ghciQueue.shift();

  if (job) {
    job.startedAt = new Date();
    const elapsed = job.startedAt - job.queuedAt;
    connection.console.log(`starting ${job.command} after ${elapsed} ms`);
    processJob(job, processGhci);
  } else {
    setTimeout(processGhci, POLL_INTERVAL);
  }
};

processGhci();

const tellGhci = (command, callback) => {
  connection.console.log(`queueing ${command}`);
  ghciQueue.push({
    callback,
    command,
    finishedAt: null,
    queuedAt: new Date(),
    startedAt: null,
  });
};

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
    codeActionProvider: true,
    completionProvider: {
      resolveProvider: true,
    },
    hoverProvider: true,
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

// It feels like there's probably a better way to get the token at a given
// position in the file.
const findToken = (params) => {
  const document = documents[params.textDocument.uri];
  if (!document) {
    return null;
  }

  const line = document[params.position.line];
  if (!line) {
    return null;
  }

  let left = params.position.character;
  while (!TOKEN_SEPARATORS.has(line.charAt(left))) {
    left -= 1;
  }
  left += 1;

  let right = params.position.character;
  while (!TOKEN_SEPARATORS.has(line.charAt(right))) {
    right += 1;
  }

  const text = line.substring(left, right);
  if (!text) {
    return null;
  }

  return { left, right, text };
};

connection.onCodeAction((params) =>
  params.context.diagnostics.flatMap((diagnostic) => {
    const lines = diagnostic.message.split(/\r?\n/);
    const index = lines.indexOf('  Valid hole fits include');
    if (index === -1) {
      console.dir(diagnostic, { depth: null });
      return [];
    }

    return lines.slice(index + 1).flatMap((line) => {
      const match = line.match(/^ {4}(\S+) ::/);
      if (!match) {
        return [];
      }

      return [
        {
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [params.textDocument.uri]: [
                {
                  newText: match[1],
                  range: params.range,
                },
              ],
            },
          },
          kind: vscode.CodeActionKind.QuickFix,
          title: `Replace with ${match[1]}`,
        },
      ];
    });
  }));

connection.onCompletion((params) => {
  const token = findToken({
    position: {
      character: params.position.character - 1,
      line: params.position.line,
    },
    textDocument: params.textDocument,
  });
  if (!token) {
    return null;
  }

  return new Promise((resolve) =>
    tellGhci(
      `:complete repl ${DESIRED_COMPLETIONS} "${token.text}"`,
      (buffer) => {
        const [header, ...lines] = buffer.trimEnd().split(/\r?\n/);
        const match = header.match(/^\d+ (\d+) (".*")$/);

        if (!match) {
          buffer.split(/\r?\n/).forEach((line) =>
            connection.console.warn(line));
          return resolve(null);
        }

        const prefix = parseJson(match[2]);
        return resolve({
          isIncomplete: match[1] > DESIRED_COMPLETIONS,
          items: lines.map((line) => ({
            label: `${prefix}${parseJson(line)}`,
          })),
        });
      }
    ));
});

connection.onCompletionResolve((params) => {
  switch (params.insertTextFormat) {
    case vscode.InsertTextFormat.PlainText:
      return new Promise((resolve) =>
        tellGhci(`:info ${params.label}`, (info) =>
          tellGhci(`:doc ${params.label}`, (doc) =>
            resolve({
              detail: presence(info),
              documentation: presence(doc),
              label: params.label,
            }))));
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

connection.onHover((params) => {
  const token = findToken(params);
  return new Promise((resolve) =>
    tellGhci(`:info ${token.text}`, (rawInfo) =>
      tellGhci(`:doc ${token.text}`, (rawDoc) => {
        let info = '';
        if (isBlank(rawInfo) || rawInfo.startsWith('{"span":')) {
          connection.console.warn(rawInfo.trimEnd());
        } else {
          info = ['``` haskell', rawInfo, '```'].join('\n');
        }

        let doc = '';
        if (isBlank(rawDoc) || rawDoc.startsWith('{"span":')) {
          connection.console.warn(rawDoc.trimEnd());
        } else {
          // This looks pretty bad because it's Haddock interpreted as
          // Markdown. Unfortunately turning Haddock into Markdown would
          // require something like Pandoc, which is a little heavyweight. So
          // for the time being it'll just be ugly.
          doc = rawDoc;
        }

        const value = [info, doc].join('\n');
        if (!value.trim()) {
          return resolve(null);
        }

        return resolve({
          contents: {
            kind: vscode.MarkupKind.Markdown,
            value,
          },
          range: {
            end: {
              character: token.right,
              line: params.position.line,
            },
            start: {
              character: token.left,
              line: params.position.line,
            },
          },
        });
      })));
});

connection.listen();
