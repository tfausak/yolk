const vscode = require('vscode-languageserver');

const connection = vscode.createConnection();

connection.onInitialize(() => {
  return {};
});

connection.listen();
