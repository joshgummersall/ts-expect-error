const {
  _: [, errorFilePath],
  dry: dryRun = false,
  todo: todoPrefix = "TODO",
  verbose = false,
} = argv;

const size = argv.sample ? parseInt(argv.sample, 10) : undefined;

const tsExpectError = "@ts-expect-error";

const tscErrorRegex =
  /^(?<filePath>[^ ]+)\((?<lineNum>\d+),(?<colNum>\d+)\): error (?<errorCode>TS\d+)\:.*/g;

const log = (operation) => [
  (...args) =>
    verbose
      ? console.log(`[INFO] ${operation}...${chalk.green("SUCCESS!")}`, ...args)
      : null,
  (...args) =>
    console.log(`[INFO] ${operation}...${chalk.red("FAILED!")}`, ...args),
];

const sample = (items, n) => {
  const selected = [],
    indices = new Set();

  while (indices.size < n) {
    const index = Math.floor(Math.random() * items.length);
    if (!indices.has(index)) {
      selected.push(items[index]);
      indices.add(index);
    }
  }

  return selected;
};

const readFileLines = async (path, { delim = "\n", enc = "utf8" } = {}) => {
  const [success, failed] = log(`Reading ${path}`);

  try {
    const contents = await fs.readFile(path, enc);
    success();

    return contents.split(delim);
  } catch (err) {
    failed(err);
    throw err;
  }
};

const writeFileLines = async (
  path,
  data,
  { delim = "\n", enc = "utf8" } = {}
) => {
  const [success, failed] = log(`Writing ${path}`);

  try {
    await fs.writeFile(path, data.join(delim), enc);
    success();
  } catch (err) {
    failed(err);
    throw err;
  }
};

const lines = await readFileLines(errorFilePath);

// Reduce into valid entries
const errors = lines.reduce((acc, line) => {
  const { groups } = tscErrorRegex.exec(line) ?? {};
  if (!groups) return acc;

  const { filePath, errorCode } = groups;
  const lineNum = parseInt(groups.lineNum, 10);
  if (Number.isNaN(lineNum)) return acc;

  return [...acc, { errorCode, filePath, lineNum }];
}, []);

// Group errors by filepath so we can mutate a single file at a time
const grouped = (size ? sample(errors, size) : errors).reduce((acc, error) => {
  if (!acc[error.filePath]) acc[error.filePath] = [];
  acc[error.filePath].push(error);
  return acc;
}, {});

// Iterate over all the groups and sort in reverse order. This allows us to insert lines
// without affecting earlier line numbers.
const sorted = Object.entries(grouped).map(([filePath, errors]) => [
  filePath,
  errors.sort((left, right) => right.lineNum - left.lineNum),
]);

// Run the operations in series so we don't produce too many iops.
await sorted.reduce(
  (acc, [filePath, errors]) =>
    acc.then(async () => {
      const fileLines = await readFileLines(filePath);

      errors.forEach(({ errorCode, lineNum }) => {
        const expectErrorText = `// ${tsExpectError} ${todoPrefix}: fix ${errorCode} violation and remove`;

        // `tsc` reports error line numbers where the first line is #1, but arrays are zero-indexed.
        // This index will be used when operating on the file lines.
        const zeroIndexLineNum = lineNum - 1;

        const currentLine = fileLines[zeroIndexLineNum];
        const previousLine = fileLines[zeroIndexLineNum - 1];

        // If the previous line already has expect-error text, skip this write.
        if (previousLine.includes(tsExpectError)) {
          return;
        }

        // Calculate the initial line offset so we correctly align comments.
        let offset = 0;
        while (offset < currentLine.length && currentLine[offset] === " ") {
          offset++;
        }

        // Helper function to generate new line number
        const newLine = `${" ".repeat(offset)}${expectErrorText}`;

        // Print a pseudo-diff representation of what we would be doing.
        if (dryRun) {
          console.log(filePath);
          console.log(chalk.green(`${lineNum}: ${newLine}`));
          console.log(`${lineNum + 1}: ${currentLine}\n`);
          return;
        }

        // Insert a new line above the error, ignoring it and recording relevant metadata for later
        // reconciliation.
        fileLines.splice(zeroIndexLineNum, 0, newLine);
      });

      // All set - write the file and move on.
      await writeFileLines(filePath, fileLines);
    }),
  Promise.resolve()
);
