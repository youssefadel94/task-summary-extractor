/**
 * Interactive CLI prompts (stdin/stdout).
 */

'use strict';

/** Prompt user for a yes/no question on stdin. Returns true for yes. */
function promptUser(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

/** Prompt user for free text input. Returns trimmed string. */
function promptUserText(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

module.exports = { promptUser, promptUserText };
