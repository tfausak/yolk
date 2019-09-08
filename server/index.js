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
  ]);

toSeverity = (severity) => {
  switch (severity) {
    case 'SevError': return vscode.DiagnosticSeverity.Error;
    case 'SevWarning': return vscode.DiagnosticSeverity.Warning;
    default: return vscode.DiagnosticSeverity.Information;
  }
};

let buffer = "";
ghci.stdout.on('data', (data) => {
  buffer += data.toString();
  const index = buffer.indexOf('\n');
  if (index !== -1) {
    const line = buffer.substring(0, index);
    buffer = buffer.substring(index + 1);
    try {
      const json = JSON.parse(line);
      connection.console.info(JSON.stringify(json));
      if (json.span) {
        connection.sendDiagnostics({
          diagnostics: [
            {
              code: json.reason,
              message: json.doc,
              range: {
                end: {
                  character: json.span.endCol,
                  line: json.span.endLine - 1,
                },
                start: {
                  character: json.span.startCol,
                  line: json.span.startLine - 1,
                },
              },
              severity: toSeverity(json.severity),
              source: 'ghc',
            }
          ],
          uri: pathToUri(json.span.file),
        });
      }
    } catch (err) {
      connection.console.warn(line);
    }
  }
});

ghci.stderr.on('data', (data) => {
  connection.console.warn(data.toString().trimEnd());
});

ghci.on('close', (code) => {
  connection.console.warn(`ghci closed with code ${code}`);
});

[
  ':set prompt ""',
  ':set prompt-cont ""',
  ':set +c',
].forEach((command) => {
  ghci.stdin.write(`${command}\n`, (err) => {
    if (err) {
      throw err;
    }
  })
});

connection.onInitialize(() => {
  connection.console.info('onInitialize');
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        save: true,
      },
    },
  };
});

// This should really use url.fileURLToPath, but VSCode uses Node 10.11.0 and
// that function was added in 10.12.0.
// <https://nodejs.org/docs/v10.12.0/api/url.html#url_url_fileurltopath_url>
const uriToPath = (uri) => decodeURIComponent(uri)
  .replace(/file:\/\/\/([a-z]):\//i, '$1:/');

const pathToUri = (path) => `file:///${encodeURIComponent(path)}`;

connection.onDidOpenTextDocument((params) => {
  const file = uriToPath(params.textDocument.uri);
  connection.console.info(`onDidOpenTextDocument ${file}`);
  ghci.stdin.write(`:load ${file}\n`, (err) => { if (err) { throw err; } });
});

connection.onDidSaveTextDocument((params) => {
  const file = uriToPath(params.textDocument.uri);
  connection.console.info(`onDidSaveTextDocument ${file}`);
  connection.sendDiagnostics({ diagnostics: [], uri: params.textDocument.uri });
  ghci.stdin.write(`:load ${file}\n`, (err) => { if (err) { throw err; } });
});

connection.onDidCloseTextDocument((params) => {
  connection.console.info(`onDidCloseTextDocument ${params.textDocument.uri}`);
});

connection.listen();
connection.console.error('Hello from Yolk!');
