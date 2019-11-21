var assert = require('assert');
var translate = require('./translate.js');
var requireFromString = require('require-from-string');
var https = require('https');
var MemoryStream = require('memorystream');
var semver = require('semver');

function setupMethods (soljson) {
  var version;
  if ('_solidity_version' in soljson) {
    version = soljson.cwrap('solidity_version', 'string', []);
  } else {
    version = soljson.cwrap('version', 'string', []);
  }

  var versionToSemver = function () {
    return translate.versionToSemver(version());
  };

  var license;
  if ('_solidity_license' in soljson) {
    license = soljson.cwrap('solidity_license', 'string', []);
  } else if ('_license' in soljson) {
    license = soljson.cwrap('license', 'string', []);
  } else {
    // pre 0.4.14
    license = function () {
      // return undefined
    };
  }

  var copyString = function (str, ptr) {
    var length = soljson.lengthBytesUTF8(str);
    var buffer = soljson._malloc(length + 1);
    soljson.stringToUTF8(str, buffer, length + 1);
    soljson.setValue(ptr, buffer, '*');
  };

  var wrapCallback = function (callback) {
    assert(typeof callback === 'function', 'Invalid callback specified.');
    return function (data, contents, error) {
      var result = callback(soljson.Pointer_stringify(data));
      if (typeof result.contents === 'string') {
        copyString(result.contents, contents);
      }
      if (typeof result.error === 'string') {
        copyString(result.error, error);
      }
    };
  };

  var wrapCallbackWithKind = function (callback) {
    assert(typeof callback === 'function', 'Invalid callback specified.');
    return function (kind, data, contents, error) {
      var result = callback(soljson.Pointer_stringify(kind), soljson.Pointer_stringify(data));
      if (typeof result.contents === 'string') {
        copyString(result.contents, contents);
      }
      if (typeof result.error === 'string') {
        copyString(result.error, error);
      }
    };
  };

  // This calls compile() with args || cb
  var runWithCallbacks = function (callbacks, compile, args) {
    if (callbacks) {
      assert(typeof callbacks === 'object', 'Invalid callback object specified.');
    } else {
      callbacks = {};
    }

    var readCallback = callbacks.import;
    if (readCallback === undefined) {
      readCallback = function (data) {
        return {
          error: 'File import callback not supported'
        };
      };
    }

    var singleCallback;
    if (semver.gt(versionToSemver(), '0.5.99')) {
      // After 0.6.x multiple kind of callbacks are supported.
      var smtSolverCallback = callbacks.smtSolver;
      if (smtSolverCallback === undefined) {
        smtSolverCallback = function (data) {
          return {
            error: 'SMT solver callback not supported'
          };
        };
      }

      singleCallback = function (kind, data) {
        if (kind === 'source') {
          return readCallback(data);
        } else if (kind === 'smt-query') {
          return smtSolverCallback(data);
        } else {
          assert(false, 'Invalid callback kind specified.');
        }
      };

      singleCallback = wrapCallbackWithKind(singleCallback);
    } else {
      // Old Solidity version only supported imports.
      singleCallback = wrapCallback(readCallback);
    }

    // This is to support multiple versions of Emscripten.
    var addFunction = soljson.addFunction || soljson.Runtime.addFunction;
    var removeFunction = soljson.removeFunction || soljson.Runtime.removeFunction;

    var cb = addFunction(singleCallback);
    var output;
    try {
      args.push(cb);
      output = compile.apply(undefined, args);
    } catch (e) {
      removeFunction(cb);
      throw e;
    }
    removeFunction(cb);
    return output;
  };

  var compileJSON = null;
  if ('_compileJSON' in soljson) {
    compileJSON = soljson.cwrap('compileJSON', 'string', ['string', 'number']);
  }

  var compileJSONMulti = null;
  if ('_compileJSONMulti' in soljson) {
    compileJSONMulti = soljson.cwrap('compileJSONMulti', 'string', ['string', 'number']);
  }

  var compileJSONCallback = null;
  if ('_compileJSONCallback' in soljson) {
    var compileInternal = soljson.cwrap('compileJSONCallback', 'string', ['string', 'number', 'number']);
    compileJSONCallback = function (input, optimize, readCallback) {
      return runWithCallbacks(readCallback, compileInternal, [ input, optimize ]);
    };
  }

  var compileStandard = null;
  if ('_compileStandard' in soljson) {
    var compileStandardInternal = soljson.cwrap('compileStandard', 'string', ['string', 'number']);
    compileStandard = function (input, readCallback) {
      return runWithCallbacks(readCallback, compileStandardInternal, [ input ]);
    };
  }
  if ('_solidity_compile' in soljson) {
    var solidityCompile = soljson.cwrap('solidity_compile', 'string', ['string', 'number']);
    compileStandard = function (input, callbacks) {
      return runWithCallbacks(callbacks, solidityCompile, [ input ]);
    };
  }

  // Expects a Standard JSON I/O but supports old compilers
  var compileStandardWrapper = function (input, readCallback) {
    if (compileStandard !== null) {
      return compileStandard(input, readCallback);
    }

    function formatFatalError (message) {
      return JSON.stringify({
        errors: [
          {
            'type': 'JSONError',
            'component': 'solcjs',
            'severity': 'error',
            'message': message,
            'formattedMessage': 'Error: ' + message
          }
        ]
      });
    }

    try {
      input = JSON.parse(input);
    } catch (e) {
      return formatFatalError('Invalid JSON supplied: ' + e.message);
    }

    if (input['language'] !== 'Solidity') {
      return formatFatalError('Only "Solidity" is supported as a language.');
    }

    // NOTE: this is deliberately `== null`
    if (input['sources'] == null || input['sources'].length === 0) {
      return formatFatalError('No input sources specified.');
    }

    // Bail out early
    if ((input['sources'].length > 1) && (compileJSONMulti === null)) {
      return formatFatalError('Multiple sources provided, but compiler only supports single input.');
    }

    function isOptimizerEnabled (input) {
      return input['settings'] && input['settings']['optimizer'] && input['settings']['optimizer']['enabled'];
    }

    function translateSources (input) {
      var sources = {};
      for (var source in input['sources']) {
        if (input['sources'][source]['content'] !== null) {
          sources[source] = input['sources'][source]['content'];
        } else {
          // force failure
          return null;
        }
      }
      return sources;
    }

    function librariesSupplied (input) {
      if (input['settings']) {
        return input['settings']['libraries'];
      }
    }

    function translateOutput (output, libraries) {
      try {
        output = JSON.parse(output);
      } catch (e) {
        return formatFatalError('Compiler returned invalid JSON: ' + e.message);
      }
      output = translate.translateJsonCompilerOutput(output, libraries);
      if (output == null) {
        return formatFatalError('Failed to process output.');
      }
      return JSON.stringify(output);
    }

    var sources = translateSources(input);
    if (sources === null || Object.keys(sources).length === 0) {
      return formatFatalError('Failed to process sources.');
    }

    // Try linking if libraries were supplied
    var libraries = librariesSupplied(input);

    // Try to wrap around old versions
    if (compileJSONCallback !== null) {
      return translateOutput(compileJSONCallback(JSON.stringify({ 'sources': sources }), isOptimizerEnabled(input), readCallback), libraries);
    }

    if (compileJSONMulti !== null) {
      return translateOutput(compileJSONMulti(JSON.stringify({ 'sources': sources }), isOptimizerEnabled(input)), libraries);
    }

    // Try our luck with an ancient compiler
    if (compileJSON !== null) {
      return translateOutput(compileJSON(sources[Object.keys(sources)[0]], isOptimizerEnabled(input)), libraries);
    }

    return formatFatalError('Compiler does not support any known interface.');
  };

  return {
    version: version,
    semver: versionToSemver,
    license: license,
    lowlevel: {
      compileSingle: compileJSON,
      compileMulti: compileJSONMulti,
      compileCallback: compileJSONCallback,
      compileStandard: compileStandard
    },
    features: {
      legacySingleInput: compileJSON !== null,
      multipleInputs: compileJSONMulti !== null || compileStandard !== null,
      importCallback: compileJSONCallback !== null || compileStandard !== null,
      nativeStandardJSON: compileStandard !== null
    },
    compile: compileStandardWrapper,
    // Loads the compiler of the given version from the github repository
    // instead of from the local filesystem.
    loadRemoteVersion: function (versionString, cb) {
      var mem = new MemoryStream(null, {readable: false});
      var url = 'https://ethereum.github.io/solc-bin/bin/soljson-' + versionString + '.js';
      https.get(url, function (response) {
        if (response.statusCode !== 200) {
          cb(new Error('Error retrieving binary: ' + response.statusMessage));
        } else {
          response.pipe(mem);
          response.on('end', function () {
            cb(null, setupMethods(requireFromString(mem.toString(), 'soljson-' + versionString + '.js')));
          });
        }
      }).on('error', function (error) {
        cb(error);
      });
    },
    // Use this if you want to add wrapper functions around the pure module.
    setupMethods: setupMethods
  };
}

module.exports = setupMethods;
