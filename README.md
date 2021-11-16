# ts-expect-error

Simple usage:

```bash
$ npm run build > errors.txt
$ zx ~/path/to/ts-expect-error/index.mjs errors.txt --todo "TODO(myalias)" --context 3 --verbose
```

Include `--dry` to just print a diff of what the script would do.
