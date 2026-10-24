import { runDemo } from '../src/demo.js';
import { errorMessage } from '../src/errors.js';
import { printJson } from '../src/json.js';

runDemo({ keepArtifacts: process.env.DEMO_KEEP === '1' })
  .then((summary) => printJson(summary))
  .catch((error) => {
    console.error(`Demo failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
