const {
  _: [, errorFilePath],
  dry: dryRun = false,
  todo: todoPrefix = "TODO",
  verbose = false,
} = argv;

const size = argv.sample ? parseInt(argv.sample, 10) : undefined;

const tsExpectError = "@ts-expect-error";

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

// Reduce into valid entries based on regexp match
const errors = lines.reduce((acc, line) => {
  const { groups } =
    /^(?<filePath>[^(]+)\((?<lineNum>\d+),(?<colNum>\d+)\):\serror\s(?<errorCode>TS\d+)\:\s(?<errorText>.*)$/g.exec(
      line
    ) ?? {};

  if (!groups) return acc;

  const { filePath, errorText } = groups;
  const lineNum = parseInt(groups.lineNum, 10);
  if (Number.isNaN(lineNum)) return acc;

  return [...acc, { errorText, filePath, lineNum }];
}, []);

// Group errors by filepath so we can mutate a single file at a time later on.
const grouped = (size ? sample(errors, size) : errors).reduce(
  (acc, { filePath, ...error }) => {
    if (!acc[filePath]) acc[filePath] = [];
    acc[filePath].push(error);
    return acc;
  },
  {}
);

// Grouping errors targeting the same line number for later formatting.
// Then, sort by reverse line number (to insert without affecting earlier lines).
const sorted = Object.entries(grouped).map(([filePath, errors]) => [
  filePath,
  Object.entries(
    errors.reduce((acc, { lineNum, errorText }) => {
      if (!acc[lineNum]) acc[lineNum] = [];
      acc[lineNum].push(errorText);
      return acc;
    }, {})
  )
    .map(([lineNum, errors]) => [parseInt(lineNum, 10), errors])
    .sort(([left], [right]) => right - left),
]);

// Run the operations in series so we don't produce too many iops.
await sorted.reduce(
  (acc, [filePath, lines]) =>
    acc.then(async () => {
      const fileLines = await readFileLines(filePath);

      lines.forEach(([lineNum, errors]) => {
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
        const newLines = [
          ...errors,
          `${tsExpectError} ${todoPrefix}: fix error and remove`,
        ].map((text) => `${" ".repeat(offset)}// ${text}`);

        // Print a pseudo-diff representation of what we would be doing.
        if (dryRun) {
          console.log(filePath);
          newLines.forEach((newLine, idx) =>
            console.log(chalk.green(`${lineNum + idx}: ${newLine}`))
          );
          console.log(`${lineNum + newLines.length}: ${currentLine}\n`);
          return;
        }

        // Insert a new line above the error, ignoring it and recording relevant metadata for later
        // reconciliation.
        fileLines.splice(zeroIndexLineNum, 0, ...newLines);
      });

      // All set - write the file and move on.
      await writeFileLines(filePath, fileLines);
    }),
  Promise.resolve()
);
