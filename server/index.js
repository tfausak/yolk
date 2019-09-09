'use strict';

const childProcess = require('child_process');
const vscode = require('vscode-languageserver');

const connection = vscode.createConnection();

// This should really use url.fileURLToPath, but VSCode uses Node 10.11.0 and
// that function was added in 10.12.0.
// <https://nodejs.org/docs/v10.12.0/api/url.html#url_url_fileurltopath_url>
const uriToPath = (uri) => decodeURIComponent(uri)
  .replace(/file:\/\/\/([a-z]):\//i, '$1:/');

// diagnostic stuff //

const files = {};

const sendDiagnostics = () => {
  Object.keys(files).forEach((file) => {
    connection.sendDiagnostics({
      diagnostics: Object.values(files[file].diagnostics),
      uri: files[file].uri,
    });
  });
};

const initializeDiagnostics = (uri) => {
  files[uriToPath(uri)] = {
    diagnostics: {},
    uri,
  };
  sendDiagnostics();
};

const toKey = (diagnostic) => [
  diagnostic.span.startLine,
  diagnostic.span.startCol,
  diagnostic.span.endLine,
  diagnostic.span.endCol,
  diagnostic.severity,
  diagnostic.reason,
  diagnostic.doc,
].join(' ');

const toRange = (span) => ({
  end: {
    character: span.endCol - 1,
    line: span.endLine - 1,
  },
  start: {
    character: span.startCol - 1,
    line: span.startLine - 1,
  },
});

const toDiagnosticSeverity = (severity) => {
  switch (severity) {
    case 'SevError': return vscode.DiagnosticSeverity.Error;
    case 'SevWarning': return vscode.DiagnosticSeverity.Warning;
    default: return vscode.DiagnosticSeverity.Information;
  }
};

const addDiagnostic = (file, diagnostic) => {
  files[file].diagnostics[toKey(diagnostic)] = {
    code: diagnostic.reason,
    message: diagnostic.doc,
    range: toRange(diagnostic.span),
    severity: toDiagnosticSeverity(diagnostic.severity),
    source: 'ghc',
  };
  sendDiagnostics();
};

const clearDiagnostics = (file) => {
  files[file].diagnostics = {};
  sendDiagnostics();
};

// ghci stuff //

const ghci = childProcess.spawn(
  'stack',
  [
    'exec',
    '--',
    'ghc',
    '--interactive',
    '-ddump-json',
  ]
);

let buffer = '';
ghci.stdout.on('data', (data) => {
  buffer += data.toString();
  const index = buffer.indexOf('\n');
  if (index !== -1) {
    const line = buffer.substring(0, index);
    buffer = buffer.substring(index + 1);
    try {
      const json = JSON.parse(line);
      addDiagnostic(json.span.file, json);
    } catch (err) {
      connection.console.warn(line);
      console.error(err);
    }
  }
});

ghci.stderr.on('data', (data) =>
  connection.console.warn(data.toString().trimEnd()));

ghci.on('close', (code, signal) =>
  connection.console.error(`ghci close ${code} ${signal}`));

[
  'prompt ""',
  'prompt-cont ""',
  '+c',
].forEach((option) =>
  ghci.stdin.write(`:set ${option}\n`, (err) => {
    if (err) {
      throw err;
    }
  }));

const loadUri = (uri) =>
  ghci.stdin.write(`:load ${uriToPath(uri)}\n`, (err) => {
    if (err) {
      throw err;
    }
  });

// language server stuff //

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: {
      openClose: true,
      save: true,
    },
  },
}));

connection.onDidOpenTextDocument((params) => {
  const { uri } = params.textDocument;
  initializeDiagnostics(uri);
  loadUri(uri);
});

connection.onDidSaveTextDocument((params) => {
  const { uri } = params.textDocument;
  clearDiagnostics(uriToPath(uri));
  loadUri(uri);
});

connection.onDidCloseTextDocument((params) =>
  clearDiagnostics(uriToPath(params.textDocument.uri)));

connection.listen();

connection.console.error([
  'Hello from Yolk!',
  'Nothing is wrong.',
  'Logging an error message makes VSCode show the output.',
  'That\'s useful during development.',
].join(' '));
