const {
  _: [, errorFilePath],
  dry = false,
  todo: todoPrefix = "TODO",
  verbose = false,
} = argv;

const context = argv.context ? parseInt(argv.context, 10) : 5;
const size = argv.sample ? parseInt(argv.sample, 10) : undefined;

const tsExpectError = "@ts-expect-error";

const jsComment = (comment) => `// ${comment}`;
const jsxComment = (comment) => `{/* ${comment} */}`;
const skipComment = () => null;

const log = (operation) => [
  () => {
    // no-op
  },
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
await sorted.reduce(async (previous, [filePath, lines], idx) => {
  await previous;

  const fileLines = await readFileLines(filePath);

  await lines.reduce(async (previous, [lineNum, errors]) => {
    await previous;

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

    // Try to determine if we're in JSX context
    const contextLines = fileLines.slice(
      zeroIndexLineNum - context,
      zeroIndexLineNum + context
    );

    // Helper function to return correct comment formatter, maybe based on user input/context
    const formatter = async () => {
      if (!filePath.endsWith(".tsx") && !filePath.endsWith(".jsx")) {
        return jsComment;
      }

      // Heh.
      if (
        !contextLines.some((line) =>
          /(([^\w]<\w+)|(\/>)|(<\/)|(={))/.test(line)
        )
      ) {
        return jsComment;
      }

      console.log(`${chalk.magenta("File:")} ${filePath}`);

      console.log(
        `${chalk.cyan("Status:")} ${sorted.length - idx - 1} files remaining`
      );
      console.log();

      console.log(chalk.red("Errors:"));
      errors.forEach((error) => console.log(` - ${error}`));
      console.log();

      console.log(chalk.yellow("Context:"));
      console.log(
        contextLines
          .map((line, idx) =>
            idx === context ? ` > ${chalk.yellow(line)}` : ` > ${line}`
          )
          .join("\n")
      );
      console.log();

      const answer = (
        await question(`${chalk.blue("Format:")} type anything for JSX... `)
      )
        ?.toLowerCase()
        ?.trim();

      console.log();

      switch (answer) {
        case "":
          return jsComment;
        case "skip":
          return skipComment;
        default:
          return jsxComment;
      }
    };

    // Format helper for jsx-aware comments
    const format = await formatter();

    // Helper function to generate new line number
    const newLines = [
      ...errors,
      `${tsExpectError} ${todoPrefix}: fix error and remove`,
    ]
      .map((comment) => {
        const formatted = format(comment);
        if (!formatted) return;

        return `${" ".repeat(offset)}${formatted}`;
      })
      .filter(Boolean);

    // Early return if we shold skip!
    if (!newLines.length) return;

    // Print a pseudo-diff representation of what we would be doing.
    if (verbose) {
      console.log(chalk.magenta(filePath));
      newLines.forEach((newLine, idx) =>
        console.log(` ${lineNum + idx}: ${chalk.green(newLine)}`)
      );
      console.log(
        ` ${lineNum + newLines.length}: ${chalk.yellow(currentLine)}\n`
      );
    }

    // Insert a new line above the error, ignoring it and recording relevant metadata for later
    // reconciliation.
    if (!dry) fileLines.splice(zeroIndexLineNum, 0, ...newLines);
  }, Promise.resolve());

  // All set - write the file and move on.
  await writeFileLines(filePath, fileLines);
}, Promise.resolve());
