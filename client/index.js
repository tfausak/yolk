'use strict';

const path = require('path');
const vscode = require('vscode-languageclient');

module.exports = {

  activate: (context) => {
    const nodeModule = {
      module: context.asAbsolutePath(path.join('server', 'index.js')),
      transport: vscode.TransportKind.ipc,
    };
    const client = new vscode.LanguageClient(
      'Yolk',
      {
        debug: nodeModule,
        run: nodeModule,
      },
      {
        documentSelector: [
          {
            language: 'haskell',
            scheme: 'file',
          },
        ],
      }
    );
    client.start();
  },

};
