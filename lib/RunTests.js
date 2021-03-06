// @flow

const chalk = require('chalk');
const chokidar = require('chokidar');
const path = require('path');
const packageInfo = require('../package.json');
const Compile = require('./Compile');
const ElmJson = require('./ElmJson');
const FindTests = require('./FindTests');
const Generate = require('./Generate');
const Project = require('./Project');
const Report = require('./Report');
const Supervisor = require('./Supervisor');

void Report;

// Incorporate the process PID into the socket name, so elm-test processes can
// be run parallel without accidentally sharing each others' sockets.
//
// See https://github.com/rtfeldman/node-test-runner/pull/231
// Also incorporate a salt number into it on Windows, to avoid EADDRINUSE -
// see https://github.com/rtfeldman/node-test-runner/issues/275 - because the
// alternative approach of deleting the file before creating a new one doesn't
// work on Windows. We have to let Windows clean up the named pipe. This is
// essentially a band-aid fix. The alternative is to rewrite a ton of stuff.
function getPipeFilename(runsExecuted /*: number */) /*: string */ {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\elm_test-${process.pid}-${runsExecuted}`
    : `/tmp/elm_test-${process.pid}.sock`;
}

function infoLog(
  report /*: typeof Report.Report */,
  msg /*: string */
) /*: void */ {
  if (report === 'console') {
    console.log(msg);
  }
}

function clearConsole(report /*: typeof Report.Report */) {
  if (report === 'console') {
    process.stdout.write(
      process.platform === 'win32' ? '\x1B[2J\x1B[0f' : '\x1B[2J\x1B[3J\x1B[H'
    );
  }
}

function diffArrays/*:: <T> */(
  from /*: Array<T> */,
  to /*: Array<T> */
) /*: { added: Array<T>, removed: Array<T> } */ {
  return {
    added: to.filter((item) => !from.includes(item)),
    removed: from.filter((item) => !to.includes(item)),
  };
}

function delay(ms /*: number */) /*: Promise<void> */ {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const Queue /*: Array<{
  event: 'added' | 'changed' | 'removed',
  filePath: string,
}> */ = [];
void Queue;

function watcherEventMessage(queue /*: typeof Queue */) /*: string */ {
  const suffix = '. Rebuilding!';

  const filePaths = Array.from(new Set(queue.map(({ filePath }) => filePath)));
  if (filePaths.length === 1) {
    const { event, filePath } = queue[0];
    return `${filePath} ${event}${suffix}`;
  }

  const events = Array.from(new Set(queue.map(({ event }) => event))).sort();
  return `${filePaths.length} files ${events.join('/')}${suffix}`;
}

function runTests(
  projectRootDir /*: string */,
  pathToElmBinary /*: string */,
  testFileGlobs /*: Array<string> */,
  processes /*: number */,
  {
    watch,
    report,
    seed,
    fuzz,
  } /*: {
    watch: boolean,
    report: typeof Report.Report,
    seed: number,
    fuzz: number,
  } */
) /*: Promise<number> */ {
  let watcher = undefined;
  let watchedPaths /*: Array<string> */ = [];
  let runsExecuted /*: number */ = 0;
  let currentRun /*: Promise<void> | void */ = undefined;
  let queue /*: typeof Queue */ = [];

  async function run() /*: Promise<number> */ {
    try {
      // Don’t delay the first run (that’s the only time the queue is empty).
      // Otherwise, wait for a little bit to batch events that happened roughly
      // at the same time. The chokidar docs also mention that by default, the
      // add event will fire when a file first appears on disk, before the
      // entire file has been written. They have a `awaitWriteFinish` option for
      // that, with a `stabilityThreshold` that is an amount of time in
      // milliseconds for a file size to remain constant before emitting its
      // event. Elm files aren’t that huge so it should be fine to just wait a
      // fixed amount of time here instead. I tried it with a 378 MB file. That
      // resulted in first a "added" event and then a "changed" event a little
      // later. So the worst thing that can happen is that you get one run with
      // half a file immediately followed by another run with the whole file.
      // I tested touching 100 files at a time. All of them produced events
      // within 60 ms on Windows, and faster on Mac and Linux. So 100 ms sounds
      // like a reasonable number – not too short, not too long of a wait.
      if (queue.length > 0) {
        await delay(100);
        // Re-print the message in case the queue has become longer while waiting.
        clearConsole(report);
        infoLog(report, watcherEventMessage(queue));
      }

      queue = [];

      // All operations down to `Generate.generateElmJson(project)` could
      // potentially be avoided depending on what changed (checking what’s
      // inside `queue`). But at the time of this writing all of them are fast
      // (less than 20 ms, often less than 1 ms) so it’s not worth bothering.

      // Files may be changed, added or removed so always re-create project info
      // from disk to stay fresh.
      const project = Project.init(projectRootDir, packageInfo.version);
      Project.validateTestsSourceDirs(project);

      const testFilePaths = FindTests.resolveGlobs(
        testFileGlobs.length === 0 ? [project.testsDir] : testFileGlobs,
        project.rootDir
      );

      if (testFilePaths.length === 0) {
        throw new Error(
          FindTests.noFilesFoundError(project.rootDir, testFileGlobs)
        );
      }

      if (watcher !== undefined) {
        const diff = diffArrays(watchedPaths, project.testsSourceDirs);
        watchedPaths = project.testsSourceDirs;
        watcher.add(diff.added);
        watcher.unwatch(diff.removed);
      }

      runsExecuted++;
      const pipeFilename = getPipeFilename(runsExecuted);
      const testModules = await FindTests.findTests(testFilePaths, project);
      const mainModule = Generate.getMainModule(project.generatedCodeDir);
      const dest = path.join(project.generatedCodeDir, 'elmTestOutput.js');

      Generate.generateElmJson(project);

      Generate.generateMainModule(
        fuzz,
        seed,
        report,
        testFileGlobs,
        testFilePaths,
        testModules,
        mainModule,
        processes
      );

      await Compile.compile(
        project.generatedCodeDir,
        mainModule.path,
        dest,
        pathToElmBinary,
        report
      );

      Generate.prepareCompiledJsFile(pipeFilename, dest);

      return await Supervisor.run(
        packageInfo.version,
        pipeFilename,
        report,
        processes,
        dest,
        watch
      );
    } catch (err) {
      console.error(err.message);
      return 1;
    }
  }

  if (watch) {
    clearConsole(report);
    infoLog(report, 'Running in watch mode');

    const onRunFinish = () => {
      if (queue.length > 0) {
        clearConsole(report);
        infoLog(report, watcherEventMessage(queue));
        currentRun = run().then(onRunFinish);
      } else {
        infoLog(report, chalk.blue('Watching for changes...'));
        currentRun = undefined;
      }
    };

    // The directories to watch change over time and are added and removed as
    // needed in `run`. We should always watch `elm.json` and `tests/`, though
    // (see the 'addDir' event below).
    const alwaysWatched = [
      ElmJson.getPath(projectRootDir),
      Project.getTestsDir(projectRootDir),
    ];

    const rerun = (event) => (absoluteFilePath) => {
      if (
        absoluteFilePath.endsWith('.elm') ||
        alwaysWatched.includes(absoluteFilePath)
      ) {
        queue.push({
          event,
          filePath: path.relative(projectRootDir, absoluteFilePath),
        });
        if (currentRun === undefined) {
          clearConsole(report);
          infoLog(report, watcherEventMessage(queue));
          currentRun = run().then(onRunFinish);
        }
      }
    };

    watcher = chokidar.watch(alwaysWatched, {
      ignoreInitial: true,
      ignored: FindTests.ignoredDirsGlobs,
      disableGlobbing: true,
    });

    watcher.on('add', rerun('added'));
    watcher.on('change', rerun('changed'));
    watcher.on('unlink', rerun('removed'));

    // The only time this event is interesting is when the `tests/` directory is
    // created after the watcher was started. There’s no need to listen for
    // 'unlinkDir' – that makes no difference.
    watcher.on('addDir', rerun('added'));

    // It’s unclear when this event occurrs.
    watcher.on('error', (error) => console.error('Watcher error:', error));

    currentRun = run().then(onRunFinish);

    // A promise that never resolves. We’ll watch until killed.
    return new Promise(() => {});
  } else {
    return run();
  }
}

module.exports = {
  runTests,
};
