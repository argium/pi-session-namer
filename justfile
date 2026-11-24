set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

default:
    @just --list

# Run every lint hook over the repository, or only over the given files. The formatters write in place; the manual stage adds the secret scan of the whole working tree. Hooks see tracked files only, so run git add on new files first.
lint *files:
    prek run {{ if files == "" { "--all-files" } else { "--files " + files } }} --stage manual --show-diff-on-failure

# Run the unit tests with Node's built-in runner, which runs the TypeScript directly.
test:
    npm test

# Run the checks that CI runs: lint, then the tests.
ci: lint test

# Install the lint hooks as the git pre-commit hook.
hooks:
    prek install
