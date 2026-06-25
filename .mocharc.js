// Mocha looks in ./test by default; our suites live in tests/. Point it there
// so `npx mocha` (used locally and in CI) discovers every *.test.js file.
module.exports = {
  spec: "tests/**/*.test.js",
};
