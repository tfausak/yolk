const path = require('path');
const vscode = require('vscode-languageclient');

module.exports = {

  activate: (context) => {
    const nodeModule = {
      module: context.asAbsolutePath(path.join('server', 'index.js')),
      transport: vscode.TransportKind.ipc,
    };
    const serverOptions = {
      debug: nodeModule,
      run: nodeModule,
    };
    const clientOptions = {
      documentSelector: [
        {
          language: 'haskell',
          scheme: 'file',
        },
      ],
    };
    new vscode.LanguageClient('Yolk', serverOptions, clientOptions).start();
  },

};
