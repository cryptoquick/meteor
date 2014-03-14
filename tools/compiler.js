var path = require('path');
var _ = require('underscore');
var watch = require('./watch.js');
var buildmessage = require('./buildmessage.js');
var archinfo = require(path.join(__dirname, 'archinfo.js'));
var linker = require('./linker.js');
var Unipackage = require('./unipackage-class.js').Unipackage;

var compiler = exports;

// Whenever you change anything about the code that generates unipackages, bump
// this version number. The idea is that the "format" field of the unipackage
// JSON file only changes when the actual specified structure of the
// unipackage/slice changes, but this version (which is build-tool-specific) can
// change when the the contents (not structure) of the built output changes. So
// eg, if we improve the linker's static analysis, this should be bumped.
//
// You should also update this whenever you update any of the packages used
// directly by the unipackage creation process (eg js-analyze) since they do not
// end up as watched dependencies. (At least for now, packages only used in
// target creation (eg minifiers and dev-bundle-fetcher) don't require you to
// update BUILT_BY, though you will need to quit and rerun "meteor run".)
compiler.BUILT_BY = 'meteor/10';

// XXX where should this go? I'll make it a random utility function
// for now
//
// 'dependencies' is the 'uses' attribute from a UnipackageSlice. Call
// 'callback' with each slice (of architecture matching `arch`)
// referenced by that dependency list. This includes directly used
// slices, and slices that are transitively "implied" by used
// slices. (But not slices that are used by slices that we use!)
// Options are skipWeak and skipUnordered, meaning to ignore direct
// "uses" that are weak or unordered.
//
// packageLoader is the PackageLoader that should be used to resolve
// the dependencies.
compiler.eachUsedSlice = function (dependencies, arch, packageLoader, options,
                                   callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  var processedSliceId = {};
  var usesToProcess = [];
  _.each(uses, function (use) {
    if (options.skipUnordered && use.unordered)
      return;
    if (options.skipWeak && use.weak)
      return;
    usesToProcess.push(use);
  });

  while (!_.isEmpty(usesToProcess)) {
    var use = usesToProcess.shift();

    var slices =
      packageLoader.getSlices(_.pick(use, 'package', 'spec'),
                                    arch);
    _.each(slices, function (slice) {
      if (_.has(processedSliceId, slice.id))
        return;
      processedSliceId[slice.id] = true;
      callback(slice, {
        unordered: !!use.unordered,
        weak: !!use.weak
      });

      _.each(slice.implies, function (implied) {
        usesToProcess.push(implied);
      });
    });
  }
};

// inputSlice is a SourceSlice to compile. Process all source files
// through the appropriate handlers and run the prelink phase on any
// resulting JavaScript. Create a new UnipackageSlice and add it to
// 'unipackage'.
//
// packageLoader is the PackageLoader to use to validate that the
// slice's dependencies actually exist (for cleaner error messages).
//
// Returns a list of source files that were used in the compilation.
var compileSlice = function (unipackage, inputSlice, packageLoader) {
  var isApp = ! inputSlice.pkg.name;
  var resources = [];
  var js = [];
  var sources = [];
  // XXX: Provide a clone method on watchset.
  var watchSet = watch.WatchSet.fromJSON(inputSlice.watchSet.toJSON());

  // (1) Preemptively check to make sure that each of the packages we
  // reference actually exist. If we find a package that doesn't
  // exist, emit an error and remove it from the package list. That
  // way we get one error about it instead of a new error at each
  // stage in the build process in which we try to retrieve the
  // package.
  var checkDependency = function (dependency) {
    var pkg = packageLoader.getPackage(dependency.package,
                                        { throwOnError: false });
    if (! pkg) {
      buildmessage.error("no such package: '" + dependency.package + "'");
      // recover by omitting this package from the field
      return false;
    }
    return true;
  };

  var uses = _.filter(inputSlice.uses, checkDependency);
  var implies = _.filter(inputSlice.implies, checkDependency);

  // (2) Determine and load active plugins

  // XXX we used to include our own extensions only if we were the
  // "use" role. now we include them everywhere because we don't have
  // a special "use" role anymore. it's not totally clear to me what
  // the correct behavior should be -- we need to resolve whether we
  // think about extensions as being global to a package or particular
  // to a slice.

  // (there's also some weirdness here with handling implies, because
  // the implies field is on the target slice, but we really only care
  // about packages.)
  var activePluginPackages = [unipackage];

  // We don't use plugins from weak dependencies, because the ability
  // to compile a certain type of file shouldn't depend on whether or
  // not some unrelated package in the target has a dependency.
  //
  // We pass archinfo.host here, not self.arch, because it may be more
  // specific, and because plugins always have to run on the host
  // architecture.
  compiler.eachUsedSlice(
    uses, archinfo.host(), packageLoader, { skipWeak: true },
    function (usedSlice) {
      activePluginPackages.push(usedSlice.pkg);
    }
  );

  activePluginPackages = _.uniq(activePluginPackages);

  // (3) Assemble the list of source file handlers from the plugins
  var allHandlers = {};

  allHandlers['js'] = function (compileStep) {
    // This is a hardcoded handler for *.js files. Since plugins
    // are written in JavaScript we have to start somewhere.
    compileStep.addJavaScript({
      data: compileStep.read().toString('utf8'),
      path: compileStep.inputPath,
      sourcePath: compileStep.inputPath,
      // XXX eventually get rid of backward-compatibility "raw" name
      // XXX COMPAT WITH 0.6.4
      bare: compileStep.fileOptions.bare || compileStep.fileOptions.raw
    });
  };

  _.each(activePluginPackages, function (otherPkg) {
    _.each(otherPkg.sourceHandlers, function (handler, ext) {
      if (ext in allHandlers && allHandlers[ext] !== handler) {
        buildmessage.error(
          "conflict: two packages included in " +
            (self.pkg.name || "the app") + ", " +
            (allHandlers[ext].pkg.name || "the app") + " and " +
            (otherPkg.name || "the app") + ", " +
            "are both trying to handle ." + ext);
        // Recover by just going with the first handler we saw
      } else {
        allHandlers[ext] = handler;
      }
    });
  });

  // (4) Determine source files
  // Note: sourceExtensions does not include leading dots
  // Note: the getSourcesFunc function isn't expected to add its
  // source files to watchSet; rather, the watchSet is for other
  // things that the getSourcesFunc consulted (such as directory
  // listings or, in some hypothetical universe, control files) to
  // determine its source files.
  var sourceExtensions = _.keys(allHandlers);
  var sourceItems = inputSlice.getSourcesFunc(sourceExtensions, watchSet);

  // (5) Process each source file
  var addAsset = function (contents, relPath, hash) {
    // XXX hack
    if (! inputSlice.pkg.name)
      relPath = relPath.replace(/^(private|public)\//, '');

    resources.push({
      type: "asset",
      data: contents,
      path: relPath,
      servePath: path.join(self.pkg.serveRoot, relPath),
      hash: hash
    });

    sources.push(relPath);
  };

  _.each(sourceItems, function (source) {
    var relPath = source.relPath;
    var fileOptions = _.clone(source.fileOptions) || {};
    var absPath = path.resolve(inputSlice.pkg.sourceRoot, relPath);
    var filename = path.basename(relPath);
    var file = watch.readAndWatchFileWithHash(watchSet, absPath);
    var contents = file.contents;

    sources.push(relPath);

    if (contents === null) {
      buildmessage.error("File not found: " + source.relPath);
      // recover by ignoring
      return;
    }

    // Find the handler for source files with this extension.
    var handler = null;
    if (! fileOptions.isAsset) {
      var parts = filename.split('.');
      for (var i = 0; i < parts.length; i++) {
        var extension = parts.slice(i).join('.');
        if (_.has(allHandlers, extension)) {
          handler = allHandlers[extension];
          break;
        }
      }
    }

    if (! handler) {
      // If we don't have an extension handler, serve this file as a
      // static resource on the client, or ignore it on the server.
      //
      // XXX This is pretty confusing, especially if you've
      // accidentally forgotten a plugin -- revisit?
      addAsset(contents, relPath, file.hash);
      return;
    }

    // This object is called a #CompileStep and it's the interface
    // to plugins that define new source file handlers (eg,
    // Coffeescript).
    //
    // Fields on CompileStep:
    //
    // - arch: the architecture for which we are building
    // - inputSize: total number of bytes in the input file
    // - inputPath: the filename and (relative) path of the input
    //   file, eg, "foo.js". We don't provide a way to get the full
    //   path because you're not supposed to read the file directly
    //   off of disk. Instead you should call read(). That way we
    //   can ensure that the version of the file that you use is
    //   exactly the one that is recorded in the dependency
    //   information.
    // - pathForSourceMap: If this file is to be included in a source map,
    //   this is the name you should use for it in the map.
    // - rootOutputPath: on browser targets, for resources such as
    //   stylesheet and static assets, this is the root URL that
    //   will get prepended to the paths you pick for your output
    //   files so that you get your own namespace, for example
    //   '/packages/foo'. null on non-browser targets
    // - fileOptions: any options passed to "api.add_files"; for
    //   use by the plugin. The built-in "js" plugin uses the "bare"
    //   option for files that shouldn't be wrapped in a closure.
    // - declaredExports: An array of symbols exported by this slice, or null
    //   if it may not export any symbols (eg, test slices). This is used by
    //   CoffeeScript to ensure that it doesn't close over those symbols, eg.
    // - read(n): read from the input file. If n is given it should
    //   be an integer, and you will receive the next n bytes of the
    //   file as a Buffer. If n is omitted you get the rest of the
    //   file.
    // - appendDocument({ section: "head", data: "my markup" })
    //   Browser targets only. Add markup to the "head" or "body"
    //   section of the document.
    // - addStylesheet({ path: "my/stylesheet.css", data: "my css",
    //                   sourceMap: "stringified json sourcemap"})
    //   Browser targets only. Add a stylesheet to the
    //   document. 'path' is a requested URL for the stylesheet that
    //   may or may not ultimately be honored. (Meteor will add
    //   appropriate tags to cause the stylesheet to be loaded. It
    //   will be subject to any stylesheet processing stages in
    //   effect, such as minification.)
    // - addJavaScript({ path: "my/program.js", data: "my code",
    //                   sourcePath: "src/my/program.js",
    //                   bare: true })
    //   Add JavaScript code, which will be namespaced into this
    //   package's environment (eg, it will see only the exports of
    //   this package's imports), and which will be subject to
    //   minification and so forth. Again, 'path' is merely a hint
    //   that may or may not be honored. 'sourcePath' is the path
    //   that will be used in any error messages generated (eg,
    //   "foo.js:4:1: syntax error"). It must be present and should
    //   be relative to the project root. Typically 'inputPath' will
    //   do handsomely. "bare" means to not wrap the file in
    //   a closure, so that its vars are shared with other files
    //   in the module.
    // - addAsset({ path: "my/image.png", data: Buffer })
    //   Add a file to serve as-is over HTTP (browser targets) or
    //   to include as-is in the bundle (os targets).
    //   This time `data` is a Buffer rather than a string. For
    //   browser targets, it will be served at the exact path you
    //   request (concatenated with rootOutputPath). For server
    //   targets, the file can be retrieved by passing path to
    //   Assets.getText or Assets.getBinary.
    // - error({ message: "There's a problem in your source file",
    //           sourcePath: "src/my/program.ext", line: 12,
    //           column: 20, func: "doStuff" })
    //   Flag an error -- at a particular location in a source
    //   file, if you like (you can even indicate a function name
    //   to show in the error, like in stack traces). sourcePath,
    //   line, column, and func are all optional.
    //
    // XXX for now, these handlers must only generate portable code
    // (code that isn't dependent on the arch, other than 'browser'
    // vs 'os') -- they can look at the arch that is provided
    // but they can't rely on the running on that particular arch
    // (in the end, an arch-specific slice will be emitted only if
    // there are native node modules). Obviously this should
    // change. A first step would be a setOutputArch() function
    // analogous to what we do with native node modules, but maybe
    // what we want is the ability to ask the plugin ahead of time
    // how specific it would like to force builds to be.
    //
    // XXX we handle encodings in a rather cavalier way and I
    // suspect we effectively end up assuming utf8. We can do better
    // than that!
    //
    // XXX addAsset probably wants to be able to set MIME type and
    // also control any manifest field we deem relevant (if any)
    //
    // XXX Some handlers process languages that have the concept of
    // include files. These are problematic because we need to
    // somehow instrument them to get the names and hashs of all of
    // the files that they read for dependency tracking purposes. We
    // don't have an API for that yet, so for now we provide a
    // workaround, which is that _fullInputPath contains the full
    // absolute path to the input files, which allows such a plugin
    // to set up its include search path. It's then on its own for
    // registering dependencies (for now..)
    //
    // XXX in the future we should give plugins an easy and clean
    // way to return errors (that could go in an overall list of
    // errors experienced across all files)
    var readOffset = 0;
    var compileStep = {
      inputSize: contents.length,
      inputPath: relPath,
      _fullInputPath: absPath, // avoid, see above..
      // XXX duplicates _pathForSourceMap() in linker
      pathForSourceMap: (
        inputSlice.pkg.name
          ? inputSlice.pkg.name + "/" + relPath
          : path.basename(relPath)),
      // null if this is an app. intended to be used for the sources
      // dictionary for source maps.
      packageName: inputSlice.pkg.name,
      rootOutputPath: inputSlice.pkg.serveRoot,
      arch: inputSlice.arch, // XXX: what is the story with arch?
      archMatches: function (pattern) {
        return archinfo.matches(inputSlice.arch, pattern);
      },
      fileOptions: fileOptions,
      declaredExports: _.pluck(inputSlice.declaredExports, 'name'),
      read: function (n) {
        if (n === undefined || readOffset + n > contents.length)
          n = contents.length - readOffset;
        var ret = contents.slice(readOffset, readOffset + n);
        readOffset += n;
        return ret;
      },
      appendDocument: function (options) {
        if (! archinfo.matches(inputSlice.arch, "browser"))
          throw new Error("Document sections can only be emitted to " +
                          "browser targets");
        if (options.section !== "head" && options.section !== "body")
          throw new Error("'section' must be 'head' or 'body'");
        if (typeof options.data !== "string")
          throw new Error("'data' option to appendDocument must be a string");
        resources.push({
          type: options.section,
          data: new Buffer(options.data, 'utf8')
        });
      },
      addStylesheet: function (options) {
        if (! archinfo.matches(inputSlice.arch, "browser"))
          throw new Error("Stylesheets can only be emitted to " +
                          "browser targets");
        if (typeof options.data !== "string")
          throw new Error("'data' option to addStylesheet must be a string");
        resources.push({
          type: "css",
          data: new Buffer(options.data, 'utf8'),
          servePath: path.join(inputSlice.pkg.serveRoot, options.path),
          sourceMap: options.sourceMap
        });
      },
      addJavaScript: function (options) {
        if (typeof options.data !== "string")
          throw new Error("'data' option to addJavaScript must be a string");
        if (typeof options.sourcePath !== "string")
          throw new Error("'sourcePath' option must be supplied to addJavaScript. Consider passing inputPath.");
        if (options.bare && ! archinfo.matches(inputSlice.arch, "browser"))
          throw new Error("'bare' option may only be used for browser targets");
        js.push({
          source: options.data,
          sourcePath: options.sourcePath,
          servePath: path.join(inputSlice.pkg.serveRoot, options.path),
          bare: !! options.bare,
          sourceMap: options.sourceMap
        });
      },
      addAsset: function (options) {
        if (! (options.data instanceof Buffer))
          throw new Error("'data' option to addAsset must be a Buffer");
        addAsset(options.data, options.path);
      },
      error: function (options) {
        buildmessage.error(options.message || ("error building " + relPath), {
          file: options.sourcePath,
          line: options.line ? options.line : undefined,
          column: options.column ? options.column : undefined,
          func: options.func ? options.func : undefined
        });
      }
    };

    try {
      (buildmessage.markBoundary(handler))(compileStep);
    } catch (e) {
      e.message = e.message + " (compiling " + relPath + ")";
      buildmessage.exception(e);

      // Recover by ignoring this source file (as best we can -- the
      // handler might already have emitted resources)
    }
  });

  // (6) Run Phase 1 link

  // Load jsAnalyze from the js-analyze package... unless we are the
  // js-analyze package, in which case never mind. (The js-analyze package's
  // default slice is not allowed to depend on anything!)
  var jsAnalyze = null;
  if (! _.isEmpty(js) && inputSlice.pkg.name !== "js-analyze") {
    jsAnalyze = unipackage.load({
      packages: ["js-analyze"]
    })["js-analyze"].JSAnalyze;
  }

  var results = linker.prelink({
    inputFiles: js,
    useGlobalNamespace: isApp,
    combinedServePath: isApp ? null :
      "/packages/" + inputSlice.pkg.name +
      (inputSlice.sliceName === "main" ? "" : (":" + inputSlice.sliceName)) + ".js",
    name: inputSlice.pkg.name || null,
    declaredExports: _.pluck(inputSlice.declaredExports, 'name'),
    jsAnalyze: jsAnalyze
  });


  // XXX: record build time dependencies
  /*
  // Add dependencies on the source code to any plugins that we could have
  // used. We need to depend even on plugins that we didn't use, because if
  // they were changed they might become relevant to us. This means that we
  // end up depending on every source file contributing to all plugins in the
  // packages we use (including source files from other packages that the
  // plugin program itself uses), as well as the package.js file from every
  // package we directly use (since changing the package.js may add or remove
  // a plugin).
  //
  // XXX: activePluginPackages is going to move here?
  _.each(self._activePluginPackages(packageLoader), function (otherPkg) {
      watchSet.merge(otherPkg.pluginWatchSet);
      // XXX this assumes this is not overwriting something different
      pluginProviderPackageDirs[otherPkg.name] =
        otherPkg.packageDirectoryForBuildInfo;
  });
  */

  // (7) Determine captured variables
  var packageVariables = [];
  var packageVariableNames = {};
  _.each(self.declaredExports, function (symbol) {
    if (_.has(packageVariableNames, symbol.name))
      return;
    packageVariables.push({
      name: symbol.name,
      export: symbol.testOnly? "tests" : true
    });
    packageVariableNames[symbol.name] = true;
  });
  _.each(results.assignedVariables, function (name) {
    if (_.has(packageVariableNames, name))
      return;
    packageVariables.push({
      name: name
    });
    packageVariableNames[name] = true;
  });

  // (8) Output slice object
  unipackage.addSlice({
    sliceName: inputSlice.sliceName,
    arch: inputSlice.arch, // XXX: arch?
    uses: uses,
    implies: implies,
    watchSet: watchSet,
    nodeModulesPath: inputSlice.nodeModulesPath,
    prelinkFiles: results.files,
    noExports: inputSlice.noExports,
    packageVariables: packageVariables,
    resources: resources
  });

  return sources;
};

// Build a PackageSource into a Unipackage by running its source files through
// the appropriate compiler plugins. Once build has completed, any errors
// detected in the package will have been emitted to buildmessage.
//
// Returns an object with keys:
// - unipackage: the build Unipackage
// - sources: array of source files (identified by their path on local
//   disk) that were used by the build (the source files you'd have to
//   ship to a different machine to replicate the build there)
complier.compile = function (sourcePackage) {
  var sources = [];
  var pluginWatchSet = new watch.WatchSet();
  var plugins = {};

  // Build plugins
  _.each(sourcePackage.pluginInfo, function (info) {
    buildmessage.enterJob({
      title: "building plugin `" + info.name +
        "` in package `" + sourcePackage.name + "`",
      rootPath: sourcePackage.sourceRoot
    }, function () {
      var buildResult = bundler.buildJsImage({
        name: info.name,
        // XXX XXX How do we determine the versions to use for a
        // plugin? These are bundle-time versions, not build-time
        // versions, so it's like building an app. The main question
        // here seems to be, what is the equivalent of a
        // .meteor/versions file for a plugin? Does it get its own
        // versions file in some hidden directory in the package? Is
        // there a way to run 'meteor update' on it or do you have
        // to do that stuff by hand?
        //
        // (obviously null is just a placeholder value until we
        // figure this out)
        packageLoader: null,
        use: info.use,
        sourceRoot: sourcePackage.sourceRoot,
        sources: info.sources,
        npmDependencies: info.npmDependencies,
        // Plugins have their own npm dependencies separate from the
        // rest of the package, so they need their own separate npm
        // shrinkwrap and cache state.
        npmDir: path.resolve(path.join(sourcePackage.sourceRoot, '.npm',
                                       'plugin', info.name))
      });

      // Add the plugin's sources to our list.
      _.each(info.sources, function (source) {
        sources.push(source);
      });

      // Add this plugin's dependencies to our "plugin dependency" WatchSet.
      pluginWatchSet.merge(buildResult.watchSet);

      // XXX: Record build-time dependencies
      /*
      // Remember the versions of all of the build-time dependencies
      // that were used.
      _.extend(self.pluginProviderPackageDirs,
               buildResult.pluginProviderPackageDirs);
      */

      // Register the built plugin's code.
      if (!_.has(plugins, info.name))
        plugins[info.name] = {};
      plugins[info.name][buildResult.image.arch] = buildResult.image;
    });
  });

  var unipackage = new Unipackage();
  unipackage.initFromOptions({
    name: sourcePackage.name,
    metadata: sourcePackage.metadata,
    version: sourcePackage.version,
    earliestCompatibleVersion: sourcePackage.earliestCompatibleVersion,
    defaultSlices: sourcePackage.defaultSlices,
    testSlices: sourcePackage.testSlices,
    packageDirectoryForBuildInfo: sourcePackage.packageDirectoryForBuildInfo,
    plugins: plugins,
    pluginWatchSet: pluginWatchSet
  });

  // XXX: what to do? this should probably be passed in.
  // var packageLoader = self._makeBuildTimePackageLoader();

  // Build slices. Might use our plugins, so needs to happen
  // second.
  _.each(sourcePackage.slices, function (slice) {
    var sources = compileSlice(unipackage, slice, packageLoader);
    sources.push.apply(sources, result.sources);
  });

  return {
    sources: _.uniq(self.sources),
    unipackage: unipackage
  };
};

// Check to see if a particular build of a package is up to date (that
// is, if the source files haven't changed and the build-time
// dependencies haven't changed, and if we're a sufficiently similar
// version of Meteor to what built it that we believe we'd generate
// identical code). True if we have dependency info and it
// says that the package is up-to-date. False if a source file or
// build-time dependency has changed.
//
// 'what' identifies the build to check for up-to-dateness and is an
// object with exactly one of the following keys:
// - path: a path on disk to a unipackage
// - unipackage: a Unipackage object
compiler.checkUpToDate = function (sourcePackage, unipackage) {
  if (unipackage.forceNotUpToDate)
    return false;

  // Do we think we'd generate different contents than the tool that
  // built this package?
  if (unipackage.builtBy !== complier.BUILT_BY)
    return false;

  // XXX XXX XXX
  var pluginProviderPackageDirs = unipackage.pluginProviderPackageDirs;

  /*
  // XXX XXX this shouldn't work this way at all. instead it should
  // just get the resolved build-time dependencies from sourcePackage
  // and make sure they match the versions that were used for the
  // build.
  var packageLoader = XXX;

  // Are all of the packages we directly use (which can provide
  // plugins which affect compilation) resolving to the same
  // directory? (eg, have we updated our release version to something
  // with a new version of a package?)
  var packageResolutionsSame = _.all(
    _pluginProviderPackageDirs, function (packageDir, name) {
      return packageLoader.getLoadPathForPackage(name) === packageDir;
    });
  if (! packageResolutionsSame)
    return false;
  */

  var watchSet = new watch.WatchSet();
  watchSet.merge(unipackage.pluginWatchSet);
  _.each(unipackage.slices, function (slice) {
    watchSet.merge(slice.watchSet);
  });

  if (! watch.isUpToDate(watchSet))
    return false;

  return true;
};