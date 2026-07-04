import assert from 'node:assert/strict';
import { extractResponseText } from '../api/resume-english.js';

const payload = {
  output: [{
    type: 'message',
    content: [{ type: 'output_text', text: '{"name":"Li Ming"}' }]
  }]
};

assert.equal(extractResponseText(payload), '{"name":"Li Ming"}');
assert.equal(extractResponseText({ output: [] }), '');

console.log('english resume response tests passed');
