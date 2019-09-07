const childProcess = require('child_process');
const vscode = require('vscode-languageserver');

const connection = vscode.createConnection();

const ghci = childProcess.spawn(
  'stack',
  [
    '--resolver',
    'ghc-8.8.1',
    'exec',
    '--',
    'ghci',
    '-ddump-json',
    '-fwrite-ide-info',
    '-Weverything',
  ]);

ghci.stdout.on('data', (data) => {
  connection.console.log(`ghci stdout: ${data}`);
});

ghci.stderr.on('data', (data) => {
  connection.console.log(`ghci stderr: ${data}`);
});

ghci.on('close', (code) => {
  connection.console.log(`ghci close: ${code}`);
});

[
  ':set prompt ">>> "',
  ':set prompt-cont "... "',
  ':set +c',
].forEach((command) => {
  connection.console.log(`ghci stdin: ${command}`);
  ghci.stdin.write(`${command}\n`, (err) => {
    if (err) {
      throw err;
    }
  })
});

connection.onInitialize(() => {
  connection.console.log('onInitialize');
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
      },
    },
  };
});

connection.onDidOpenTextDocument((params) => {
  // This should really use url.fileURLToPath, but VSCode uses Node 10.11.0 and
  // that function was added in 10.12.0.
  // <https://nodejs.org/docs/v10.12.0/api/url.html#url_url_fileurltopath_url>
  const file = decodeURIComponent(params.textDocument.uri)
    .replace(/file:\/\/\/([a-z]):\//i, '$1:/');

  connection.console.log(`onDidOpenTextDocument ${file}`);
  ghci.stdin.write(`:load ${file}\n`, (err) => { if (err) { throw err; } });
});

connection.onDidCloseTextDocument((params) => {
  connection.console.log(`onDidCloseTextDocument ${params.textDocument.uri}`);
});

connection.listen();
connection.console.error('Hello from Yolk!');

// example diagnostic
/*
connection.onDidChangeTextDocument((params) => {
  log(`onDidChangeTextDocument: ${params.textDocument.uri}`);
  const diagnostics = [];
  if (Math.random() < 0.5) {
    log('adding sample diagnostic');
    diagnostics.push({
      code: 'yolk-diagnostic-code',
      message: 'yolk-diagnostic-message',
      range: {
        end: {
          character: 1,
          line: 0,
        },
        start: {
          character: 0,
          line: 0,
        },
      },
      severity: vscode.DiagnosticSeverity.Hint,
      source: 'yolk-diagnostic-source',
    });
  }
  connection.sendDiagnostics({ diagnostics, uri: params.textDocument.uri });
});
*/
