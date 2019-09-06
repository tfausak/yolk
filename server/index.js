const vscode = require('vscode-languageserver');

const connection = vscode.createConnection();

const log = (message) => connection.console.info(`[yolk] ${message}`);

connection.onInitialize(() => {
  return {
    capabilities: {
      textDocumentSync: {
        change: vscode.TextDocumentSyncKind.Incremental,
        openClose: true,
      },
    },
    trace: 'verbose',
  };
});

connection.onDidOpenTextDocument((params) => {
  log(`onDidOpenTextDocument: ${params.textDocument.uri}`);
});

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

connection.listen();
