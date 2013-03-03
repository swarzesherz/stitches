/** vim: et:ts=4:sw=4:sts=4
 * @license RequireJS 2.1.4 Copyright (c) 2010-2012, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
//Not using strict: uneven strict support in browsers, #392, and causes
//problems with requirejs.exec()/transpiler plugins that may not be strict.
/*jslint regexp: true, nomen: true, sloppy: true */
/*global window, navigator, document, importScripts, setTimeout, opera */

var requirejs, require, define;
(function (global) {
    var req, s, head, baseElement, dataMain, src,
        interactiveScript, currentlyAddingScript, mainScript, subPath,
        version = '2.1.4',
        commentRegExp = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg,
        cjsRequireRegExp = /[^.]\s*require\s*\(\s*["']([^'"\s]+)["']\s*\)/g,
        jsSuffixRegExp = /\.js$/,
        currDirRegExp = /^\.\//,
        op = Object.prototype,
        ostring = op.toString,
        hasOwn = op.hasOwnProperty,
        ap = Array.prototype,
        apsp = ap.splice,
        isBrowser = !!(typeof window !== 'undefined' && navigator && document),
        isWebWorker = !isBrowser && typeof importScripts !== 'undefined',
        //PS3 indicates loaded and complete, but need to wait for complete
        //specifically. Sequence is 'loading', 'loaded', execution,
        // then 'complete'. The UA check is unfortunate, but not sure how
        //to feature test w/o causing perf issues.
        readyRegExp = isBrowser && navigator.platform === 'PLAYSTATION 3' ?
                      /^complete$/ : /^(complete|loaded)$/,
        defContextName = '_',
        //Oh the tragedy, detecting opera. See the usage of isOpera for reason.
        isOpera = typeof opera !== 'undefined' && opera.toString() === '[object Opera]',
        contexts = {},
        cfg = {},
        globalDefQueue = [],
        useInteractive = false;

    function isFunction(it) {
        return ostring.call(it) === '[object Function]';
    }

    function isArray(it) {
        return ostring.call(it) === '[object Array]';
    }

    /**
     * Helper function for iterating over an array. If the func returns
     * a true value, it will break out of the loop.
     */
    function each(ary, func) {
        if (ary) {
            var i;
            for (i = 0; i < ary.length; i += 1) {
                if (ary[i] && func(ary[i], i, ary)) {
                    break;
                }
            }
        }
    }

    /**
     * Helper function for iterating over an array backwards. If the func
     * returns a true value, it will break out of the loop.
     */
    function eachReverse(ary, func) {
        if (ary) {
            var i;
            for (i = ary.length - 1; i > -1; i -= 1) {
                if (ary[i] && func(ary[i], i, ary)) {
                    break;
                }
            }
        }
    }

    function hasProp(obj, prop) {
        return hasOwn.call(obj, prop);
    }

    function getOwn(obj, prop) {
        return hasProp(obj, prop) && obj[prop];
    }

    /**
     * Cycles over properties in an object and calls a function for each
     * property value. If the function returns a truthy value, then the
     * iteration is stopped.
     */
    function eachProp(obj, func) {
        var prop;
        for (prop in obj) {
            if (hasProp(obj, prop)) {
                if (func(obj[prop], prop)) {
                    break;
                }
            }
        }
    }

    /**
     * Simple function to mix in properties from source into target,
     * but only if target does not already have a property of the same name.
     */
    function mixin(target, source, force, deepStringMixin) {
        if (source) {
            eachProp(source, function (value, prop) {
                if (force || !hasProp(target, prop)) {
                    if (deepStringMixin && typeof value !== 'string') {
                        if (!target[prop]) {
                            target[prop] = {};
                        }
                        mixin(target[prop], value, force, deepStringMixin);
                    } else {
                        target[prop] = value;
                    }
                }
            });
        }
        return target;
    }

    //Similar to Function.prototype.bind, but the 'this' object is specified
    //first, since it is easier to read/figure out what 'this' will be.
    function bind(obj, fn) {
        return function () {
            return fn.apply(obj, arguments);
        };
    }

    function scripts() {
        return document.getElementsByTagName('script');
    }

    //Allow getting a global that expressed in
    //dot notation, like 'a.b.c'.
    function getGlobal(value) {
        if (!value) {
            return value;
        }
        var g = global;
        each(value.split('.'), function (part) {
            g = g[part];
        });
        return g;
    }

    /**
     * Constructs an error with a pointer to an URL with more information.
     * @param {String} id the error ID that maps to an ID on a web page.
     * @param {String} message human readable error.
     * @param {Error} [err] the original error, if there is one.
     *
     * @returns {Error}
     */
    function makeError(id, msg, err, requireModules) {
        var e = new Error(msg + '\nhttp://requirejs.org/docs/errors.html#' + id);
        e.requireType = id;
        e.requireModules = requireModules;
        if (err) {
            e.originalError = err;
        }
        return e;
    }

    if (typeof define !== 'undefined') {
        //If a define is already in play via another AMD loader,
        //do not overwrite.
        return;
    }

    if (typeof requirejs !== 'undefined') {
        if (isFunction(requirejs)) {
            //Do not overwrite and existing requirejs instance.
            return;
        }
        cfg = requirejs;
        requirejs = undefined;
    }

    //Allow for a require config object
    if (typeof require !== 'undefined' && !isFunction(require)) {
        //assume it is a config object.
        cfg = require;
        require = undefined;
    }

    function newContext(contextName) {
        var inCheckLoaded, Module, context, handlers,
            checkLoadedTimeoutId,
            config = {
                waitSeconds: 7,
                baseUrl: './',
                paths: {},
                pkgs: {},
                shim: {},
                map: {},
                config: {}
            },
            registry = {},
            undefEvents = {},
            defQueue = [],
            defined = {},
            urlFetched = {},
            requireCounter = 1,
            unnormalizedCounter = 1;

        /**
         * Trims the . and .. from an array of path segments.
         * It will keep a leading path segment if a .. will become
         * the first path segment, to help with module name lookups,
         * which act like paths, but can be remapped. But the end result,
         * all paths that use this function should look normalized.
         * NOTE: this method MODIFIES the input array.
         * @param {Array} ary the array of path segments.
         */
        function trimDots(ary) {
            var i, part;
            for (i = 0; ary[i]; i += 1) {
                part = ary[i];
                if (part === '.') {
                    ary.splice(i, 1);
                    i -= 1;
                } else if (part === '..') {
                    if (i === 1 && (ary[2] === '..' || ary[0] === '..')) {
                        //End of the line. Keep at least one non-dot
                        //path segment at the front so it can be mapped
                        //correctly to disk. Otherwise, there is likely
                        //no path mapping for a path starting with '..'.
                        //This can still fail, but catches the most reasonable
                        //uses of ..
                        break;
                    } else if (i > 0) {
                        ary.splice(i - 1, 2);
                        i -= 2;
                    }
                }
            }
        }

        /**
         * Given a relative module name, like ./something, normalize it to
         * a real name that can be mapped to a path.
         * @param {String} name the relative name
         * @param {String} baseName a real name that the name arg is relative
         * to.
         * @param {Boolean} applyMap apply the map config to the value. Should
         * only be done if this normalization is for a dependency ID.
         * @returns {String} normalized name
         */
        function normalize(name, baseName, applyMap) {
            var pkgName, pkgConfig, mapValue, nameParts, i, j, nameSegment,
                foundMap, foundI, foundStarMap, starI,
                baseParts = baseName && baseName.split('/'),
                normalizedBaseParts = baseParts,
                map = config.map,
                starMap = map && map['*'];

            //Adjust any relative paths.
            if (name && name.charAt(0) === '.') {
                //If have a base name, try to normalize against it,
                //otherwise, assume it is a top-level require that will
                //be relative to baseUrl in the end.
                if (baseName) {
                    if (getOwn(config.pkgs, baseName)) {
                        //If the baseName is a package name, then just treat it as one
                        //name to concat the name with.
                        normalizedBaseParts = baseParts = [baseName];
                    } else {
                        //Convert baseName to array, and lop off the last part,
                        //so that . matches that 'directory' and not name of the baseName's
                        //module. For instance, baseName of 'one/two/three', maps to
                        //'one/two/three.js', but we want the directory, 'one/two' for
                        //this normalization.
                        normalizedBaseParts = baseParts.slice(0, baseParts.length - 1);
                    }

                    name = normalizedBaseParts.concat(name.split('/'));
                    trimDots(name);

                    //Some use of packages may use a . path to reference the
                    //'main' module name, so normalize for that.
                    pkgConfig = getOwn(config.pkgs, (pkgName = name[0]));
                    name = name.join('/');
                    if (pkgConfig && name === pkgName + '/' + pkgConfig.main) {
                        name = pkgName;
                    }
                } else if (name.indexOf('./') === 0) {
                    // No baseName, so this is ID is resolved relative
                    // to baseUrl, pull off the leading dot.
                    name = name.substring(2);
                }
            }

            //Apply map config if available.
            if (applyMap && (baseParts || starMap) && map) {
                nameParts = name.split('/');

                for (i = nameParts.length; i > 0; i -= 1) {
                    nameSegment = nameParts.slice(0, i).join('/');

                    if (baseParts) {
                        //Find the longest baseName segment match in the config.
                        //So, do joins on the biggest to smallest lengths of baseParts.
                        for (j = baseParts.length; j > 0; j -= 1) {
                            mapValue = getOwn(map, baseParts.slice(0, j).join('/'));

                            //baseName segment has config, find if it has one for
                            //this name.
                            if (mapValue) {
                                mapValue = getOwn(mapValue, nameSegment);
                                if (mapValue) {
                                    //Match, update name to the new value.
                                    foundMap = mapValue;
                                    foundI = i;
                                    break;
                                }
                            }
                        }
                    }

                    if (foundMap) {
                        break;
                    }

                    //Check for a star map match, but just hold on to it,
                    //if there is a shorter segment match later in a matching
                    //config, then favor over this star map.
                    if (!foundStarMap && starMap && getOwn(starMap, nameSegment)) {
                        foundStarMap = getOwn(starMap, nameSegment);
                        starI = i;
                    }
                }

                if (!foundMap && foundStarMap) {
                    foundMap = foundStarMap;
                    foundI = starI;
                }

                if (foundMap) {
                    nameParts.splice(0, foundI, foundMap);
                    name = nameParts.join('/');
                }
            }

            return name;
        }

        function removeScript(name) {
            if (isBrowser) {
                each(scripts(), function (scriptNode) {
                    if (scriptNode.getAttribute('data-requiremodule') === name &&
                            scriptNode.getAttribute('data-requirecontext') === context.contextName) {
                        scriptNode.parentNode.removeChild(scriptNode);
                        return true;
                    }
                });
            }
        }

        function hasPathFallback(id) {
            var pathConfig = getOwn(config.paths, id);
            if (pathConfig && isArray(pathConfig) && pathConfig.length > 1) {
                removeScript(id);
                //Pop off the first array value, since it failed, and
                //retry
                pathConfig.shift();
                context.require.undef(id);
                context.require([id]);
                return true;
            }
        }

        //Turns a plugin!resource to [plugin, resource]
        //with the plugin being undefined if the name
        //did not have a plugin prefix.
        function splitPrefix(name) {
            var prefix,
                index = name ? name.indexOf('!') : -1;
            if (index > -1) {
                prefix = name.substring(0, index);
                name = name.substring(index + 1, name.length);
            }
            return [prefix, name];
        }

        /**
         * Creates a module mapping that includes plugin prefix, module
         * name, and path. If parentModuleMap is provided it will
         * also normalize the name via require.normalize()
         *
         * @param {String} name the module name
         * @param {String} [parentModuleMap] parent module map
         * for the module name, used to resolve relative names.
         * @param {Boolean} isNormalized: is the ID already normalized.
         * This is true if this call is done for a define() module ID.
         * @param {Boolean} applyMap: apply the map config to the ID.
         * Should only be true if this map is for a dependency.
         *
         * @returns {Object}
         */
        function makeModuleMap(name, parentModuleMap, isNormalized, applyMap) {
            var url, pluginModule, suffix, nameParts,
                prefix = null,
                parentName = parentModuleMap ? parentModuleMap.name : null,
                originalName = name,
                isDefine = true,
                normalizedName = '';

            //If no name, then it means it is a require call, generate an
            //internal name.
            if (!name) {
                isDefine = false;
                name = '_@r' + (requireCounter += 1);
            }

            nameParts = splitPrefix(name);
            prefix = nameParts[0];
            name = nameParts[1];

            if (prefix) {
                prefix = normalize(prefix, parentName, applyMap);
                pluginModule = getOwn(defined, prefix);
            }

            //Account for relative paths if there is a base name.
            if (name) {
                if (prefix) {
                    if (pluginModule && pluginModule.normalize) {
                        //Plugin is loaded, use its normalize method.
                        normalizedName = pluginModule.normalize(name, function (name) {
                            return normalize(name, parentName, applyMap);
                        });
                    } else {
                        normalizedName = normalize(name, parentName, applyMap);
                    }
                } else {
                    //A regular module.
                    normalizedName = normalize(name, parentName, applyMap);

                    //Normalized name may be a plugin ID due to map config
                    //application in normalize. The map config values must
                    //already be normalized, so do not need to redo that part.
                    nameParts = splitPrefix(normalizedName);
                    prefix = nameParts[0];
                    normalizedName = nameParts[1];
                    isNormalized = true;

                    url = context.nameToUrl(normalizedName);
                }
            }

            //If the id is a plugin id that cannot be determined if it needs
            //normalization, stamp it with a unique ID so two matching relative
            //ids that may conflict can be separate.
            suffix = prefix && !pluginModule && !isNormalized ?
                     '_unnormalized' + (unnormalizedCounter += 1) :
                     '';

            return {
                prefix: prefix,
                name: normalizedName,
                parentMap: parentModuleMap,
                unnormalized: !!suffix,
                url: url,
                originalName: originalName,
                isDefine: isDefine,
                id: (prefix ?
                        prefix + '!' + normalizedName :
                        normalizedName) + suffix
            };
        }

        function getModule(depMap) {
            var id = depMap.id,
                mod = getOwn(registry, id);

            if (!mod) {
                mod = registry[id] = new context.Module(depMap);
            }

            return mod;
        }

        function on(depMap, name, fn) {
            var id = depMap.id,
                mod = getOwn(registry, id);

            if (hasProp(defined, id) &&
                    (!mod || mod.defineEmitComplete)) {
                if (name === 'defined') {
                    fn(defined[id]);
                }
            } else {
                getModule(depMap).on(name, fn);
            }
        }

        function onError(err, errback) {
            var ids = err.requireModules,
                notified = false;

            if (errback) {
                errback(err);
            } else {
                each(ids, function (id) {
                    var mod = getOwn(registry, id);
                    if (mod) {
                        //Set error on module, so it skips timeout checks.
                        mod.error = err;
                        if (mod.events.error) {
                            notified = true;
                            mod.emit('error', err);
                        }
                    }
                });

                if (!notified) {
                    req.onError(err);
                }
            }
        }

        /**
         * Internal method to transfer globalQueue items to this context's
         * defQueue.
         */
        function takeGlobalQueue() {
            //Push all the globalDefQueue items into the context's defQueue
            if (globalDefQueue.length) {
                //Array splice in the values since the context code has a
                //local var ref to defQueue, so cannot just reassign the one
                //on context.
                apsp.apply(defQueue,
                           [defQueue.length - 1, 0].concat(globalDefQueue));
                globalDefQueue = [];
            }
        }

        handlers = {
            'require': function (mod) {
                if (mod.require) {
                    return mod.require;
                } else {
                    return (mod.require = context.makeRequire(mod.map));
                }
            },
            'exports': function (mod) {
                mod.usingExports = true;
                if (mod.map.isDefine) {
                    if (mod.exports) {
                        return mod.exports;
                    } else {
                        return (mod.exports = defined[mod.map.id] = {});
                    }
                }
            },
            'module': function (mod) {
                if (mod.module) {
                    return mod.module;
                } else {
                    return (mod.module = {
                        id: mod.map.id,
                        uri: mod.map.url,
                        config: function () {
                            return (config.config && getOwn(config.config, mod.map.id)) || {};
                        },
                        exports: defined[mod.map.id]
                    });
                }
            }
        };

        function cleanRegistry(id) {
            //Clean up machinery used for waiting modules.
            delete registry[id];
        }

        function breakCycle(mod, traced, processed) {
            var id = mod.map.id;

            if (mod.error) {
                mod.emit('error', mod.error);
            } else {
                traced[id] = true;
                each(mod.depMaps, function (depMap, i) {
                    var depId = depMap.id,
                        dep = getOwn(registry, depId);

                    //Only force things that have not completed
                    //being defined, so still in the registry,
                    //and only if it has not been matched up
                    //in the module already.
                    if (dep && !mod.depMatched[i] && !processed[depId]) {
                        if (getOwn(traced, depId)) {
                            mod.defineDep(i, defined[depId]);
                            mod.check(); //pass false?
                        } else {
                            breakCycle(dep, traced, processed);
                        }
                    }
                });
                processed[id] = true;
            }
        }

        function checkLoaded() {
            var map, modId, err, usingPathFallback,
                waitInterval = config.waitSeconds * 1000,
                //It is possible to disable the wait interval by using waitSeconds of 0.
                expired = waitInterval && (context.startTime + waitInterval) < new Date().getTime(),
                noLoads = [],
                reqCalls = [],
                stillLoading = false,
                needCycleCheck = true;

            //Do not bother if this call was a result of a cycle break.
            if (inCheckLoaded) {
                return;
            }

            inCheckLoaded = true;

            //Figure out the state of all the modules.
            eachProp(registry, function (mod) {
                map = mod.map;
                modId = map.id;

                //Skip things that are not enabled or in error state.
                if (!mod.enabled) {
                    return;
                }

                if (!map.isDefine) {
                    reqCalls.push(mod);
                }

                if (!mod.error) {
                    //If the module should be executed, and it has not
                    //been inited and time is up, remember it.
                    if (!mod.inited && expired) {
                        if (hasPathFallback(modId)) {
                            usingPathFallback = true;
                            stillLoading = true;
                        } else {
                            noLoads.push(modId);
                            removeScript(modId);
                        }
                    } else if (!mod.inited && mod.fetched && map.isDefine) {
                        stillLoading = true;
                        if (!map.prefix) {
                            //No reason to keep looking for unfinished
                            //loading. If the only stillLoading is a
                            //plugin resource though, keep going,
                            //because it may be that a plugin resource
                            //is waiting on a non-plugin cycle.
                            return (needCycleCheck = false);
                        }
                    }
                }
            });

            if (expired && noLoads.length) {
                //If wait time expired, throw error of unloaded modules.
                err = makeError('timeout', 'Load timeout for modules: ' + noLoads, null, noLoads);
                err.contextName = context.contextName;
                return onError(err);
            }

            //Not expired, check for a cycle.
            if (needCycleCheck) {
                each(reqCalls, function (mod) {
                    breakCycle(mod, {}, {});
                });
            }

            //If still waiting on loads, and the waiting load is something
            //other than a plugin resource, or there are still outstanding
            //scripts, then just try back later.
            if ((!expired || usingPathFallback) && stillLoading) {
                //Something is still waiting to load. Wait for it, but only
                //if a timeout is not already in effect.
                if ((isBrowser || isWebWorker) && !checkLoadedTimeoutId) {
                    checkLoadedTimeoutId = setTimeout(function () {
                        checkLoadedTimeoutId = 0;
                        checkLoaded();
                    }, 50);
                }
            }

            inCheckLoaded = false;
        }

        Module = function (map) {
            this.events = getOwn(undefEvents, map.id) || {};
            this.map = map;
            this.shim = getOwn(config.shim, map.id);
            this.depExports = [];
            this.depMaps = [];
            this.depMatched = [];
            this.pluginMaps = {};
            this.depCount = 0;

            /* this.exports this.factory
               this.depMaps = [],
               this.enabled, this.fetched
            */
        };

        Module.prototype = {
            init: function (depMaps, factory, errback, options) {
                options = options || {};

                //Do not do more inits if already done. Can happen if there
                //are multiple define calls for the same module. That is not
                //a normal, common case, but it is also not unexpected.
                if (this.inited) {
                    return;
                }

                this.factory = factory;

                if (errback) {
                    //Register for errors on this module.
                    this.on('error', errback);
                } else if (this.events.error) {
                    //If no errback already, but there are error listeners
                    //on this module, set up an errback to pass to the deps.
                    errback = bind(this, function (err) {
                        this.emit('error', err);
                    });
                }

                //Do a copy of the dependency array, so that
                //source inputs are not modified. For example
                //"shim" deps are passed in here directly, and
                //doing a direct modification of the depMaps array
                //would affect that config.
                this.depMaps = depMaps && depMaps.slice(0);

                this.errback = errback;

                //Indicate this module has be initialized
                this.inited = true;

                this.ignore = options.ignore;

                //Could have option to init this module in enabled mode,
                //or could have been previously marked as enabled. However,
                //the dependencies are not known until init is called. So
                //if enabled previously, now trigger dependencies as enabled.
                if (options.enabled || this.enabled) {
                    //Enable this module and dependencies.
                    //Will call this.check()
                    this.enable();
                } else {
                    this.check();
                }
            },

            defineDep: function (i, depExports) {
                //Because of cycles, defined callback for a given
                //export can be called more than once.
                if (!this.depMatched[i]) {
                    this.depMatched[i] = true;
                    this.depCount -= 1;
                    this.depExports[i] = depExports;
                }
            },

            fetch: function () {
                if (this.fetched) {
                    return;
                }
                this.fetched = true;

                context.startTime = (new Date()).getTime();

                var map = this.map;

                //If the manager is for a plugin managed resource,
                //ask the plugin to load it now.
                if (this.shim) {
                    context.makeRequire(this.map, {
                        enableBuildCallback: true
                    })(this.shim.deps || [], bind(this, function () {
                        return map.prefix ? this.callPlugin() : this.load();
                    }));
                } else {
                    //Regular dependency.
                    return map.prefix ? this.callPlugin() : this.load();
                }
            },

            load: function () {
                var url = this.map.url;

                //Regular dependency.
                if (!urlFetched[url]) {
                    urlFetched[url] = true;
                    context.load(this.map.id, url);
                }
            },

            /**
             * Checks is the module is ready to define itself, and if so,
             * define it.
             */
            check: function () {
                if (!this.enabled || this.enabling) {
                    return;
                }

                var err, cjsModule,
                    id = this.map.id,
                    depExports = this.depExports,
                    exports = this.exports,
                    factory = this.factory;

                if (!this.inited) {
                    this.fetch();
                } else if (this.error) {
                    this.emit('error', this.error);
                } else if (!this.defining) {
                    //The factory could trigger another require call
                    //that would result in checking this module to
                    //define itself again. If already in the process
                    //of doing that, skip this work.
                    this.defining = true;

                    if (this.depCount < 1 && !this.defined) {
                        if (isFunction(factory)) {
                            //If there is an error listener, favor passing
                            //to that instead of throwing an error.
                            if (this.events.error) {
                                try {
                                    exports = context.execCb(id, factory, depExports, exports);
                                } catch (e) {
                                    err = e;
                                }
                            } else {
                                exports = context.execCb(id, factory, depExports, exports);
                            }

                            if (this.map.isDefine) {
                                //If setting exports via 'module' is in play,
                                //favor that over return value and exports. After that,
                                //favor a non-undefined return value over exports use.
                                cjsModule = this.module;
                                if (cjsModule &&
                                        cjsModule.exports !== undefined &&
                                        //Make sure it is not already the exports value
                                        cjsModule.exports !== this.exports) {
                                    exports = cjsModule.exports;
                                } else if (exports === undefined && this.usingExports) {
                                    //exports already set the defined value.
                                    exports = this.exports;
                                }
                            }

                            if (err) {
                                err.requireMap = this.map;
                                err.requireModules = [this.map.id];
                                err.requireType = 'define';
                                return onError((this.error = err));
                            }

                        } else {
                            //Just a literal value
                            exports = factory;
                        }

                        this.exports = exports;

                        if (this.map.isDefine && !this.ignore) {
                            defined[id] = exports;

                            if (req.onResourceLoad) {
                                req.onResourceLoad(context, this.map, this.depMaps);
                            }
                        }

                        //Clean up
                        delete registry[id];

                        this.defined = true;
                    }

                    //Finished the define stage. Allow calling check again
                    //to allow define notifications below in the case of a
                    //cycle.
                    this.defining = false;

                    if (this.defined && !this.defineEmitted) {
                        this.defineEmitted = true;
                        this.emit('defined', this.exports);
                        this.defineEmitComplete = true;
                    }

                }
            },

            callPlugin: function () {
                var map = this.map,
                    id = map.id,
                    //Map already normalized the prefix.
                    pluginMap = makeModuleMap(map.prefix);

                //Mark this as a dependency for this plugin, so it
                //can be traced for cycles.
                this.depMaps.push(pluginMap);

                on(pluginMap, 'defined', bind(this, function (plugin) {
                    var load, normalizedMap, normalizedMod,
                        name = this.map.name,
                        parentName = this.map.parentMap ? this.map.parentMap.name : null,
                        localRequire = context.makeRequire(map.parentMap, {
                            enableBuildCallback: true
                        });

                    //If current map is not normalized, wait for that
                    //normalized name to load instead of continuing.
                    if (this.map.unnormalized) {
                        //Normalize the ID if the plugin allows it.
                        if (plugin.normalize) {
                            name = plugin.normalize(name, function (name) {
                                return normalize(name, parentName, true);
                            }) || '';
                        }

                        //prefix and name should already be normalized, no need
                        //for applying map config again either.
                        normalizedMap = makeModuleMap(map.prefix + '!' + name,
                                                      this.map.parentMap);
                        on(normalizedMap,
                            'defined', bind(this, function (value) {
                                this.init([], function () { return value; }, null, {
                                    enabled: true,
                                    ignore: true
                                });
                            }));

                        normalizedMod = getOwn(registry, normalizedMap.id);
                        if (normalizedMod) {
                            //Mark this as a dependency for this plugin, so it
                            //can be traced for cycles.
                            this.depMaps.push(normalizedMap);

                            if (this.events.error) {
                                normalizedMod.on('error', bind(this, function (err) {
                                    this.emit('error', err);
                                }));
                            }
                            normalizedMod.enable();
                        }

                        return;
                    }

                    load = bind(this, function (value) {
                        this.init([], function () { return value; }, null, {
                            enabled: true
                        });
                    });

                    load.error = bind(this, function (err) {
                        this.inited = true;
                        this.error = err;
                        err.requireModules = [id];

                        //Remove temp unnormalized modules for this module,
                        //since they will never be resolved otherwise now.
                        eachProp(registry, function (mod) {
                            if (mod.map.id.indexOf(id + '_unnormalized') === 0) {
                                cleanRegistry(mod.map.id);
                            }
                        });

                        onError(err);
                    });

                    //Allow plugins to load other code without having to know the
                    //context or how to 'complete' the load.
                    load.fromText = bind(this, function (text, textAlt) {
                        /*jslint evil: true */
                        var moduleName = map.name,
                            moduleMap = makeModuleMap(moduleName),
                            hasInteractive = useInteractive;

                        //As of 2.1.0, support just passing the text, to reinforce
                        //fromText only being called once per resource. Still
                        //support old style of passing moduleName but discard
                        //that moduleName in favor of the internal ref.
                        if (textAlt) {
                            text = textAlt;
                        }

                        //Turn off interactive script matching for IE for any define
                        //calls in the text, then turn it back on at the end.
                        if (hasInteractive) {
                            useInteractive = false;
                        }

                        //Prime the system by creating a module instance for
                        //it.
                        getModule(moduleMap);

                        //Transfer any config to this other module.
                        if (hasProp(config.config, id)) {
                            config.config[moduleName] = config.config[id];
                        }

                        try {
                            req.exec(text);
                        } catch (e) {
                            return onError(makeError('fromtexteval',
                                             'fromText eval for ' + id +
                                            ' failed: ' + e,
                                             e,
                                             [id]));
                        }

                        if (hasInteractive) {
                            useInteractive = true;
                        }

                        //Mark this as a dependency for the plugin
                        //resource
                        this.depMaps.push(moduleMap);

                        //Support anonymous modules.
                        context.completeLoad(moduleName);

                        //Bind the value of that module to the value for this
                        //resource ID.
                        localRequire([moduleName], load);
                    });

                    //Use parentName here since the plugin's name is not reliable,
                    //could be some weird string with no path that actually wants to
                    //reference the parentName's path.
                    plugin.load(map.name, localRequire, load, config);
                }));

                context.enable(pluginMap, this);
                this.pluginMaps[pluginMap.id] = pluginMap;
            },

            enable: function () {
                this.enabled = true;

                //Set flag mentioning that the module is enabling,
                //so that immediate calls to the defined callbacks
                //for dependencies do not trigger inadvertent load
                //with the depCount still being zero.
                this.enabling = true;

                //Enable each dependency
                each(this.depMaps, bind(this, function (depMap, i) {
                    var id, mod, handler;

                    if (typeof depMap === 'string') {
                        //Dependency needs to be converted to a depMap
                        //and wired up to this module.
                        depMap = makeModuleMap(depMap,
                                               (this.map.isDefine ? this.map : this.map.parentMap),
                                               false,
                                               !this.skipMap);
                        this.depMaps[i] = depMap;

                        handler = getOwn(handlers, depMap.id);

                        if (handler) {
                            this.depExports[i] = handler(this);
                            return;
                        }

                        this.depCount += 1;

                        on(depMap, 'defined', bind(this, function (depExports) {
                            this.defineDep(i, depExports);
                            this.check();
                        }));

                        if (this.errback) {
                            on(depMap, 'error', this.errback);
                        }
                    }

                    id = depMap.id;
                    mod = registry[id];

                    //Skip special modules like 'require', 'exports', 'module'
                    //Also, don't call enable if it is already enabled,
                    //important in circular dependency cases.
                    if (!hasProp(handlers, id) && mod && !mod.enabled) {
                        context.enable(depMap, this);
                    }
                }));

                //Enable each plugin that is used in
                //a dependency
                eachProp(this.pluginMaps, bind(this, function (pluginMap) {
                    var mod = getOwn(registry, pluginMap.id);
                    if (mod && !mod.enabled) {
                        context.enable(pluginMap, this);
                    }
                }));

                this.enabling = false;

                this.check();
            },

            on: function (name, cb) {
                var cbs = this.events[name];
                if (!cbs) {
                    cbs = this.events[name] = [];
                }
                cbs.push(cb);
            },

            emit: function (name, evt) {
                each(this.events[name], function (cb) {
                    cb(evt);
                });
                if (name === 'error') {
                    //Now that the error handler was triggered, remove
                    //the listeners, since this broken Module instance
                    //can stay around for a while in the registry.
                    delete this.events[name];
                }
            }
        };

        function callGetModule(args) {
            //Skip modules already defined.
            if (!hasProp(defined, args[0])) {
                getModule(makeModuleMap(args[0], null, true)).init(args[1], args[2]);
            }
        }

        function removeListener(node, func, name, ieName) {
            //Favor detachEvent because of IE9
            //issue, see attachEvent/addEventListener comment elsewhere
            //in this file.
            if (node.detachEvent && !isOpera) {
                //Probably IE. If not it will throw an error, which will be
                //useful to know.
                if (ieName) {
                    node.detachEvent(ieName, func);
                }
            } else {
                node.removeEventListener(name, func, false);
            }
        }

        /**
         * Given an event from a script node, get the requirejs info from it,
         * and then removes the event listeners on the node.
         * @param {Event} evt
         * @returns {Object}
         */
        function getScriptData(evt) {
            //Using currentTarget instead of target for Firefox 2.0's sake. Not
            //all old browsers will be supported, but this one was easy enough
            //to support and still makes sense.
            var node = evt.currentTarget || evt.srcElement;

            //Remove the listeners once here.
            removeListener(node, context.onScriptLoad, 'load', 'onreadystatechange');
            removeListener(node, context.onScriptError, 'error');

            return {
                node: node,
                id: node && node.getAttribute('data-requiremodule')
            };
        }

        function intakeDefines() {
            var args;

            //Any defined modules in the global queue, intake them now.
            takeGlobalQueue();

            //Make sure any remaining defQueue items get properly processed.
            while (defQueue.length) {
                args = defQueue.shift();
                if (args[0] === null) {
                    return onError(makeError('mismatch', 'Mismatched anonymous define() module: ' + args[args.length - 1]));
                } else {
                    //args are id, deps, factory. Should be normalized by the
                    //define() function.
                    callGetModule(args);
                }
            }
        }

        context = {
            config: config,
            contextName: contextName,
            registry: registry,
            defined: defined,
            urlFetched: urlFetched,
            defQueue: defQueue,
            Module: Module,
            makeModuleMap: makeModuleMap,
            nextTick: req.nextTick,

            /**
             * Set a configuration for the context.
             * @param {Object} cfg config object to integrate.
             */
            configure: function (cfg) {
                //Make sure the baseUrl ends in a slash.
                if (cfg.baseUrl) {
                    if (cfg.baseUrl.charAt(cfg.baseUrl.length - 1) !== '/') {
                        cfg.baseUrl += '/';
                    }
                }

                //Save off the paths and packages since they require special processing,
                //they are additive.
                var pkgs = config.pkgs,
                    shim = config.shim,
                    objs = {
                        paths: true,
                        config: true,
                        map: true
                    };

                eachProp(cfg, function (value, prop) {
                    if (objs[prop]) {
                        if (prop === 'map') {
                            mixin(config[prop], value, true, true);
                        } else {
                            mixin(config[prop], value, true);
                        }
                    } else {
                        config[prop] = value;
                    }
                });

                //Merge shim
                if (cfg.shim) {
                    eachProp(cfg.shim, function (value, id) {
                        //Normalize the structure
                        if (isArray(value)) {
                            value = {
                                deps: value
                            };
                        }
                        if ((value.exports || value.init) && !value.exportsFn) {
                            value.exportsFn = context.makeShimExports(value);
                        }
                        shim[id] = value;
                    });
                    config.shim = shim;
                }

                //Adjust packages if necessary.
                if (cfg.packages) {
                    each(cfg.packages, function (pkgObj) {
                        var location;

                        pkgObj = typeof pkgObj === 'string' ? { name: pkgObj } : pkgObj;
                        location = pkgObj.location;

                        //Create a brand new object on pkgs, since currentPackages can
                        //be passed in again, and config.pkgs is the internal transformed
                        //state for all package configs.
                        pkgs[pkgObj.name] = {
                            name: pkgObj.name,
                            location: location || pkgObj.name,
                            //Remove leading dot in main, so main paths are normalized,
                            //and remove any trailing .js, since different package
                            //envs have different conventions: some use a module name,
                            //some use a file name.
                            main: (pkgObj.main || 'main')
                                  .replace(currDirRegExp, '')
                                  .replace(jsSuffixRegExp, '')
                        };
                    });

                    //Done with modifications, assing packages back to context config
                    config.pkgs = pkgs;
                }

                //If there are any "waiting to execute" modules in the registry,
                //update the maps for them, since their info, like URLs to load,
                //may have changed.
                eachProp(registry, function (mod, id) {
                    //If module already has init called, since it is too
                    //late to modify them, and ignore unnormalized ones
                    //since they are transient.
                    if (!mod.inited && !mod.map.unnormalized) {
                        mod.map = makeModuleMap(id);
                    }
                });

                //If a deps array or a config callback is specified, then call
                //require with those args. This is useful when require is defined as a
                //config object before require.js is loaded.
                if (cfg.deps || cfg.callback) {
                    context.require(cfg.deps || [], cfg.callback);
                }
            },

            makeShimExports: function (value) {
                function fn() {
                    var ret;
                    if (value.init) {
                        ret = value.init.apply(global, arguments);
                    }
                    return ret || (value.exports && getGlobal(value.exports));
                }
                return fn;
            },

            makeRequire: function (relMap, options) {
                options = options || {};

                function localRequire(deps, callback, errback) {
                    var id, map, requireMod;

                    if (options.enableBuildCallback && callback && isFunction(callback)) {
                        callback.__requireJsBuild = true;
                    }

                    if (typeof deps === 'string') {
                        if (isFunction(callback)) {
                            //Invalid call
                            return onError(makeError('requireargs', 'Invalid require call'), errback);
                        }

                        //If require|exports|module are requested, get the
                        //value for them from the special handlers. Caveat:
                        //this only works while module is being defined.
                        if (relMap && hasProp(handlers, deps)) {
                            return handlers[deps](registry[relMap.id]);
                        }

                        //Synchronous access to one module. If require.get is
                        //available (as in the Node adapter), prefer that.
                        if (req.get) {
                            return req.get(context, deps, relMap);
                        }

                        //Normalize module name, if it contains . or ..
                        map = makeModuleMap(deps, relMap, false, true);
                        id = map.id;

                        if (!hasProp(defined, id)) {
                            return onError(makeError('notloaded', 'Module name "' +
                                        id +
                                        '" has not been loaded yet for context: ' +
                                        contextName +
                                        (relMap ? '' : '. Use require([])')));
                        }
                        return defined[id];
                    }

                    //Grab defines waiting in the global queue.
                    intakeDefines();

                    //Mark all the dependencies as needing to be loaded.
                    context.nextTick(function () {
                        //Some defines could have been added since the
                        //require call, collect them.
                        intakeDefines();

                        requireMod = getModule(makeModuleMap(null, relMap));

                        //Store if map config should be applied to this require
                        //call for dependencies.
                        requireMod.skipMap = options.skipMap;

                        requireMod.init(deps, callback, errback, {
                            enabled: true
                        });

                        checkLoaded();
                    });

                    return localRequire;
                }

                mixin(localRequire, {
                    isBrowser: isBrowser,

                    /**
                     * Converts a module name + .extension into an URL path.
                     * *Requires* the use of a module name. It does not support using
                     * plain URLs like nameToUrl.
                     */
                    toUrl: function (moduleNamePlusExt) {
                        var ext, url,
                            index = moduleNamePlusExt.lastIndexOf('.'),
                            segment = moduleNamePlusExt.split('/')[0],
                            isRelative = segment === '.' || segment === '..';

                        //Have a file extension alias, and it is not the
                        //dots from a relative path.
                        if (index !== -1 && (!isRelative || index > 1)) {
                            ext = moduleNamePlusExt.substring(index, moduleNamePlusExt.length);
                            moduleNamePlusExt = moduleNamePlusExt.substring(0, index);
                        }

                        url = context.nameToUrl(normalize(moduleNamePlusExt,
                                                relMap && relMap.id, true), ext || '.fake');
                        return ext ? url : url.substring(0, url.length - 5);
                    },

                    defined: function (id) {
                        return hasProp(defined, makeModuleMap(id, relMap, false, true).id);
                    },

                    specified: function (id) {
                        id = makeModuleMap(id, relMap, false, true).id;
                        return hasProp(defined, id) || hasProp(registry, id);
                    }
                });

                //Only allow undef on top level require calls
                if (!relMap) {
                    localRequire.undef = function (id) {
                        //Bind any waiting define() calls to this context,
                        //fix for #408
                        takeGlobalQueue();

                        var map = makeModuleMap(id, relMap, true),
                            mod = getOwn(registry, id);

                        delete defined[id];
                        delete urlFetched[map.url];
                        delete undefEvents[id];

                        if (mod) {
                            //Hold on to listeners in case the
                            //module will be attempted to be reloaded
                            //using a different config.
                            if (mod.events.defined) {
                                undefEvents[id] = mod.events;
                            }

                            cleanRegistry(id);
                        }
                    };
                }

                return localRequire;
            },

            /**
             * Called to enable a module if it is still in the registry
             * awaiting enablement. A second arg, parent, the parent module,
             * is passed in for context, when this method is overriden by
             * the optimizer. Not shown here to keep code compact.
             */
            enable: function (depMap) {
                var mod = getOwn(registry, depMap.id);
                if (mod) {
                    getModule(depMap).enable();
                }
            },

            /**
             * Internal method used by environment adapters to complete a load event.
             * A load event could be a script load or just a load pass from a synchronous
             * load call.
             * @param {String} moduleName the name of the module to potentially complete.
             */
            completeLoad: function (moduleName) {
                var found, args, mod,
                    shim = getOwn(config.shim, moduleName) || {},
                    shExports = shim.exports;

                takeGlobalQueue();

                while (defQueue.length) {
                    args = defQueue.shift();
                    if (args[0] === null) {
                        args[0] = moduleName;
                        //If already found an anonymous module and bound it
                        //to this name, then this is some other anon module
                        //waiting for its completeLoad to fire.
                        if (found) {
                            break;
                        }
                        found = true;
                    } else if (args[0] === moduleName) {
                        //Found matching define call for this script!
                        found = true;
                    }

                    callGetModule(args);
                }

                //Do this after the cycle of callGetModule in case the result
                //of those calls/init calls changes the registry.
                mod = getOwn(registry, moduleName);

                if (!found && !hasProp(defined, moduleName) && mod && !mod.inited) {
                    if (config.enforceDefine && (!shExports || !getGlobal(shExports))) {
                        if (hasPathFallback(moduleName)) {
                            return;
                        } else {
                            return onError(makeError('nodefine',
                                             'No define call for ' + moduleName,
                                             null,
                                             [moduleName]));
                        }
                    } else {
                        //A script that does not call define(), so just simulate
                        //the call for it.
                        callGetModule([moduleName, (shim.deps || []), shim.exportsFn]);
                    }
                }

                checkLoaded();
            },

            /**
             * Converts a module name to a file path. Supports cases where
             * moduleName may actually be just an URL.
             * Note that it **does not** call normalize on the moduleName,
             * it is assumed to have already been normalized. This is an
             * internal API, not a public one. Use toUrl for the public API.
             */
            nameToUrl: function (moduleName, ext) {
                var paths, pkgs, pkg, pkgPath, syms, i, parentModule, url,
                    parentPath;

                //If a colon is in the URL, it indicates a protocol is used and it is just
                //an URL to a file, or if it starts with a slash, contains a query arg (i.e. ?)
                //or ends with .js, then assume the user meant to use an url and not a module id.
                //The slash is important for protocol-less URLs as well as full paths.
                if (req.jsExtRegExp.test(moduleName)) {
                    //Just a plain path, not module name lookup, so just return it.
                    //Add extension if it is included. This is a bit wonky, only non-.js things pass
                    //an extension, this method probably needs to be reworked.
                    url = moduleName + (ext || '');
                } else {
                    //A module that needs to be converted to a path.
                    paths = config.paths;
                    pkgs = config.pkgs;

                    syms = moduleName.split('/');
                    //For each module name segment, see if there is a path
                    //registered for it. Start with most specific name
                    //and work up from it.
                    for (i = syms.length; i > 0; i -= 1) {
                        parentModule = syms.slice(0, i).join('/');
                        pkg = getOwn(pkgs, parentModule);
                        parentPath = getOwn(paths, parentModule);
                        if (parentPath) {
                            //If an array, it means there are a few choices,
                            //Choose the one that is desired
                            if (isArray(parentPath)) {
                                parentPath = parentPath[0];
                            }
                            syms.splice(0, i, parentPath);
                            break;
                        } else if (pkg) {
                            //If module name is just the package name, then looking
                            //for the main module.
                            if (moduleName === pkg.name) {
                                pkgPath = pkg.location + '/' + pkg.main;
                            } else {
                                pkgPath = pkg.location;
                            }
                            syms.splice(0, i, pkgPath);
                            break;
                        }
                    }

                    //Join the path parts together, then figure out if baseUrl is needed.
                    url = syms.join('/');
                    url += (ext || (/\?/.test(url) ? '' : '.js'));
                    url = (url.charAt(0) === '/' || url.match(/^[\w\+\.\-]+:/) ? '' : config.baseUrl) + url;
                }

                return config.urlArgs ? url +
                                        ((url.indexOf('?') === -1 ? '?' : '&') +
                                         config.urlArgs) : url;
            },

            //Delegates to req.load. Broken out as a separate function to
            //allow overriding in the optimizer.
            load: function (id, url) {
                req.load(context, id, url);
            },

            /**
             * Executes a module callack function. Broken out as a separate function
             * solely to allow the build system to sequence the files in the built
             * layer in the right sequence.
             *
             * @private
             */
            execCb: function (name, callback, args, exports) {
                return callback.apply(exports, args);
            },

            /**
             * callback for script loads, used to check status of loading.
             *
             * @param {Event} evt the event from the browser for the script
             * that was loaded.
             */
            onScriptLoad: function (evt) {
                //Using currentTarget instead of target for Firefox 2.0's sake. Not
                //all old browsers will be supported, but this one was easy enough
                //to support and still makes sense.
                if (evt.type === 'load' ||
                        (readyRegExp.test((evt.currentTarget || evt.srcElement).readyState))) {
                    //Reset interactive script so a script node is not held onto for
                    //to long.
                    interactiveScript = null;

                    //Pull out the name of the module and the context.
                    var data = getScriptData(evt);
                    context.completeLoad(data.id);
                }
            },

            /**
             * Callback for script errors.
             */
            onScriptError: function (evt) {
                var data = getScriptData(evt);
                if (!hasPathFallback(data.id)) {
                    return onError(makeError('scripterror', 'Script error', evt, [data.id]));
                }
            }
        };

        context.require = context.makeRequire();
        return context;
    }

    /**
     * Main entry point.
     *
     * If the only argument to require is a string, then the module that
     * is represented by that string is fetched for the appropriate context.
     *
     * If the first argument is an array, then it will be treated as an array
     * of dependency string names to fetch. An optional function callback can
     * be specified to execute when all of those dependencies are available.
     *
     * Make a local req variable to help Caja compliance (it assumes things
     * on a require that are not standardized), and to give a short
     * name for minification/local scope use.
     */
    req = requirejs = function (deps, callback, errback, optional) {

        //Find the right context, use default
        var context, config,
            contextName = defContextName;

        // Determine if have config object in the call.
        if (!isArray(deps) && typeof deps !== 'string') {
            // deps is a config object
            config = deps;
            if (isArray(callback)) {
                // Adjust args if there are dependencies
                deps = callback;
                callback = errback;
                errback = optional;
            } else {
                deps = [];
            }
        }

        if (config && config.context) {
            contextName = config.context;
        }

        context = getOwn(contexts, contextName);
        if (!context) {
            context = contexts[contextName] = req.s.newContext(contextName);
        }

        if (config) {
            context.configure(config);
        }

        return context.require(deps, callback, errback);
    };

    /**
     * Support require.config() to make it easier to cooperate with other
     * AMD loaders on globally agreed names.
     */
    req.config = function (config) {
        return req(config);
    };

    /**
     * Execute something after the current tick
     * of the event loop. Override for other envs
     * that have a better solution than setTimeout.
     * @param  {Function} fn function to execute later.
     */
    req.nextTick = typeof setTimeout !== 'undefined' ? function (fn) {
        setTimeout(fn, 4);
    } : function (fn) { fn(); };

    /**
     * Export require as a global, but only if it does not already exist.
     */
    if (!require) {
        require = req;
    }

    req.version = version;

    //Used to filter out dependencies that are already paths.
    req.jsExtRegExp = /^\/|:|\?|\.js$/;
    req.isBrowser = isBrowser;
    s = req.s = {
        contexts: contexts,
        newContext: newContext
    };

    //Create default context.
    req({});

    //Exports some context-sensitive methods on global require.
    each([
        'toUrl',
        'undef',
        'defined',
        'specified'
    ], function (prop) {
        //Reference from contexts instead of early binding to default context,
        //so that during builds, the latest instance of the default context
        //with its config gets used.
        req[prop] = function () {
            var ctx = contexts[defContextName];
            return ctx.require[prop].apply(ctx, arguments);
        };
    });

    if (isBrowser) {
        head = s.head = document.getElementsByTagName('head')[0];
        //If BASE tag is in play, using appendChild is a problem for IE6.
        //When that browser dies, this can be removed. Details in this jQuery bug:
        //http://dev.jquery.com/ticket/2709
        baseElement = document.getElementsByTagName('base')[0];
        if (baseElement) {
            head = s.head = baseElement.parentNode;
        }
    }

    /**
     * Any errors that require explicitly generates will be passed to this
     * function. Intercept/override it if you want custom error handling.
     * @param {Error} err the error object.
     */
    req.onError = function (err) {
        throw err;
    };

    /**
     * Does the request to load a module for the browser case.
     * Make this a separate function to allow other environments
     * to override it.
     *
     * @param {Object} context the require context to find state.
     * @param {String} moduleName the name of the module.
     * @param {Object} url the URL to the module.
     */
    req.load = function (context, moduleName, url) {
        var config = (context && context.config) || {},
            node;
        if (isBrowser) {
            //In the browser so use a script tag
            node = config.xhtml ?
                    document.createElementNS('http://www.w3.org/1999/xhtml', 'html:script') :
                    document.createElement('script');
            node.type = config.scriptType || 'text/javascript';
            node.charset = 'utf-8';
            node.async = true;

            node.setAttribute('data-requirecontext', context.contextName);
            node.setAttribute('data-requiremodule', moduleName);

            //Set up load listener. Test attachEvent first because IE9 has
            //a subtle issue in its addEventListener and script onload firings
            //that do not match the behavior of all other browsers with
            //addEventListener support, which fire the onload event for a
            //script right after the script execution. See:
            //https://connect.microsoft.com/IE/feedback/details/648057/script-onload-event-is-not-fired-immediately-after-script-execution
            //UNFORTUNATELY Opera implements attachEvent but does not follow the script
            //script execution mode.
            if (node.attachEvent &&
                    //Check if node.attachEvent is artificially added by custom script or
                    //natively supported by browser
                    //read https://github.com/jrburke/requirejs/issues/187
                    //if we can NOT find [native code] then it must NOT natively supported.
                    //in IE8, node.attachEvent does not have toString()
                    //Note the test for "[native code" with no closing brace, see:
                    //https://github.com/jrburke/requirejs/issues/273
                    !(node.attachEvent.toString && node.attachEvent.toString().indexOf('[native code') < 0) &&
                    !isOpera) {
                //Probably IE. IE (at least 6-8) do not fire
                //script onload right after executing the script, so
                //we cannot tie the anonymous define call to a name.
                //However, IE reports the script as being in 'interactive'
                //readyState at the time of the define call.
                useInteractive = true;

                node.attachEvent('onreadystatechange', context.onScriptLoad);
                //It would be great to add an error handler here to catch
                //404s in IE9+. However, onreadystatechange will fire before
                //the error handler, so that does not help. If addEvenListener
                //is used, then IE will fire error before load, but we cannot
                //use that pathway given the connect.microsoft.com issue
                //mentioned above about not doing the 'script execute,
                //then fire the script load event listener before execute
                //next script' that other browsers do.
                //Best hope: IE10 fixes the issues,
                //and then destroys all installs of IE 6-9.
                //node.attachEvent('onerror', context.onScriptError);
            } else {
                node.addEventListener('load', context.onScriptLoad, false);
                node.addEventListener('error', context.onScriptError, false);
            }
            node.src = url;

            //For some cache cases in IE 6-8, the script executes before the end
            //of the appendChild execution, so to tie an anonymous define
            //call to the module name (which is stored on the node), hold on
            //to a reference to this node, but clear after the DOM insertion.
            currentlyAddingScript = node;
            if (baseElement) {
                head.insertBefore(node, baseElement);
            } else {
                head.appendChild(node);
            }
            currentlyAddingScript = null;

            return node;
        } else if (isWebWorker) {
            //In a web worker, use importScripts. This is not a very
            //efficient use of importScripts, importScripts will block until
            //its script is downloaded and evaluated. However, if web workers
            //are in play, the expectation that a build has been done so that
            //only one script needs to be loaded anyway. This may need to be
            //reevaluated if other use cases become common.
            importScripts(url);

            //Account for anonymous modules
            context.completeLoad(moduleName);
        }
    };

    function getInteractiveScript() {
        if (interactiveScript && interactiveScript.readyState === 'interactive') {
            return interactiveScript;
        }

        eachReverse(scripts(), function (script) {
            if (script.readyState === 'interactive') {
                return (interactiveScript = script);
            }
        });
        return interactiveScript;
    }

    //Look for a data-main script attribute, which could also adjust the baseUrl.
    if (isBrowser) {
        //Figure out baseUrl. Get it from the script tag with require.js in it.
        eachReverse(scripts(), function (script) {
            //Set the 'head' where we can append children by
            //using the script's parent.
            if (!head) {
                head = script.parentNode;
            }

            //Look for a data-main attribute to set main script for the page
            //to load. If it is there, the path to data main becomes the
            //baseUrl, if it is not already set.
            dataMain = script.getAttribute('data-main');
            if (dataMain) {
                //Set final baseUrl if there is not already an explicit one.
                if (!cfg.baseUrl) {
                    //Pull off the directory of data-main for use as the
                    //baseUrl.
                    src = dataMain.split('/');
                    mainScript = src.pop();
                    subPath = src.length ? src.join('/')  + '/' : './';

                    cfg.baseUrl = subPath;
                    dataMain = mainScript;
                }

                //Strip off any trailing .js since dataMain is now
                //like a module name.
                dataMain = dataMain.replace(jsSuffixRegExp, '');

                //Put the data-main script in the files to load.
                cfg.deps = cfg.deps ? cfg.deps.concat(dataMain) : [dataMain];

                return true;
            }
        });
    }

    /**
     * The function that handles definitions of modules. Differs from
     * require() in that a string for the module should be the first argument,
     * and the function to execute after dependencies are loaded should
     * return a value to define the module corresponding to the first argument's
     * name.
     */
    define = function (name, deps, callback) {
        var node, context;

        //Allow for anonymous modules
        if (typeof name !== 'string') {
            //Adjust args appropriately
            callback = deps;
            deps = name;
            name = null;
        }

        //This module may not have dependencies
        if (!isArray(deps)) {
            callback = deps;
            deps = [];
        }

        //If no name, and callback is a function, then figure out if it a
        //CommonJS thing with dependencies.
        if (!deps.length && isFunction(callback)) {
            //Remove comments from the callback string,
            //look for require calls, and pull them into the dependencies,
            //but only if there are function args.
            if (callback.length) {
                callback
                    .toString()
                    .replace(commentRegExp, '')
                    .replace(cjsRequireRegExp, function (match, dep) {
                        deps.push(dep);
                    });

                //May be a CommonJS thing even without require calls, but still
                //could use exports, and module. Avoid doing exports and module
                //work though if it just needs require.
                //REQUIRES the function to expect the CommonJS variables in the
                //order listed below.
                deps = (callback.length === 1 ? ['require'] : ['require', 'exports', 'module']).concat(deps);
            }
        }

        //If in IE 6-8 and hit an anonymous define() call, do the interactive
        //work.
        if (useInteractive) {
            node = currentlyAddingScript || getInteractiveScript();
            if (node) {
                if (!name) {
                    name = node.getAttribute('data-requiremodule');
                }
                context = contexts[node.getAttribute('data-requirecontext')];
            }
        }

        //Always save off evaluating the def call until the script onload handler.
        //This allows multiple modules to be in a file without prematurely
        //tracing dependencies, and allows for anonymous module support,
        //where the module name is not known until the script onload event
        //occurs. If no context, use the global queue, and get it processed
        //in the onscript load callback.
        (context ? context.defQueue : globalDefQueue).push([name, deps, callback]);
    };

    define.amd = {
        jQuery: true
    };


    /**
     * Executes the text. Normally just uses eval, but can be modified
     * to use a better, environment-specific call. Only used for transpiling
     * loader plugins, not for plain JS modules.
     * @param {String} text the text to execute/evaluate.
     */
    req.exec = function (text) {
        /*jslint evil: true */
        return eval(text);
    };

    //Set up with config info.
    req(cfg);
}(this));
/**
 * # wrap/jquery
 *
 * Wrap global instance for use in RequireJS modules
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define, jQuery */

define('jquery',[],function () {
    "use strict";
    return jQuery;
});
/**
 * # wrap/modernizr
 *
 * Wrap global instance for use in RequireJS modules
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define, Modernizr */

define('modernizr',[],function () {
    "use strict";
    return Modernizr;
});
/* Copyright (c) 2010-2012 Marcus Westin */;(function(){
	var store = {},
		win = window,
		doc = win.document,
		localStorageName = 'localStorage',
		namespace = '__storejs__',
		storage

	store.disabled = false
	store.set = function(key, value) {}
	store.get = function(key) {}
	store.remove = function(key) {}
	store.clear = function() {}
	store.transact = function(key, defaultVal, transactionFn) {
		var val = store.get(key)
		if (transactionFn == null) {
			transactionFn = defaultVal
			defaultVal = null
		}
		if (typeof val == 'undefined') { val = defaultVal || {} }
		transactionFn(val)
		store.set(key, val)
	}
	store.setAll = function() {}
	store.getAll = function() {}

	store.serialize = function(value) {
		return JSON.stringify(value)
	}
	store.deserialize = function(value) {
		if (typeof value != 'string') { return undefined }
		try { return JSON.parse(value) }
		catch(e) { return value || undefined }
	}

	// Functions to encapsulate questionable FireFox 3.6.13 behavior
	// when about.config::dom.storage.enabled === false
	// See https://github.com/marcuswestin/store.js/issues#issue/13
	function isLocalStorageNameSupported() {
		try { return (localStorageName in win && win[localStorageName]) }
		catch(err) { return false }
	}

	if (isLocalStorageNameSupported()) {
		storage = win[localStorageName]
		store.set = function(key, val) {
			if (typeof key == "object") { return store.setAll(key) }
			if (val === undefined) { return store.remove(key) }
			storage.setItem(key, store.serialize(val))
			return val
		}
		store.get = function(key) {
			if (key === undefined) { return store.getAll() }
			return store.deserialize(storage.getItem(key))
		}
		store.remove = function(key) { storage.removeItem(key) }
		store.clear = function() { storage.clear() }
		store.setAll = function (vals) {
			for (var i in vals) {
				vals[i] = store.set(i, vals[i])
			}
		}
		store.getAll = function() {
			var ret = {}
			for (var i=0; i<storage.length; ++i) {
				var key = storage.key(i)
				ret[key] = store.get(key)
			}
			return ret
		}
	} else if (doc.documentElement.addBehavior) {
		var storageOwner,
			storageContainer
		// Since #userData storage applies only to specific paths, we need to
		// somehow link our data to a specific path.  We choose /favicon.ico
		// as a pretty safe option, since all browsers already make a request to
		// this URL anyway and being a 404 will not hurt us here.  We wrap an
		// iframe pointing to the favicon in an ActiveXObject(htmlfile) object
		// (see: http://msdn.microsoft.com/en-us/library/aa752574(v=VS.85).aspx)
		// since the iframe access rules appear to allow direct access and
		// manipulation of the document element, even for a 404 page.  This
		// document can be used instead of the current document (which would
		// have been limited to the current path) to perform #userData storage.
		try {
			storageContainer = new ActiveXObject('htmlfile')
			storageContainer.open()
			storageContainer.write('<s' + 'cript>document.w=window</s' + 'cript><iframe src="/favicon.ico"></frame>')
			storageContainer.close()
			storageOwner = storageContainer.w.frames[0].document
			storage = storageOwner.createElement('div')
		} catch(e) {
			// somehow ActiveXObject instantiation failed (perhaps some special
			// security settings or otherwse), fall back to per-path storage
			storage = doc.createElement('div')
			storageOwner = doc.body
		}
		function withIEStorage(storeFunction) {
			return function() {
				var args = Array.prototype.slice.call(arguments, 0)
				args.unshift(storage)
				// See http://msdn.microsoft.com/en-us/library/ms531081(v=VS.85).aspx
				// and http://msdn.microsoft.com/en-us/library/ms531424(v=VS.85).aspx
				storageOwner.appendChild(storage)
				storage.addBehavior('#default#userData')
				storage.load(localStorageName)
				var result = storeFunction.apply(store, args)
				storageOwner.removeChild(storage)
				return result
			}
		}

		// In IE7, keys may not contain special chars. See all of https://github.com/marcuswestin/store.js/issues/40
		var forbiddenCharsRegex = new RegExp("[!\"#$%&'()*+,/\\\\:;<=>?@[\\]^`{|}~]", "g")
		function ieKeyFix(key) {
			return key.replace(forbiddenCharsRegex, '___')
		}
		store.set = withIEStorage(function(storage, key, val) {
			if (typeof key == "object") { return store.setAll(key) }
			key = ieKeyFix(key)
			if (val === undefined) { return store.remove(key) }
			storage.setAttribute(key, store.serialize(val))
			storage.save(localStorageName)
			return val
		})
		store.get = withIEStorage(function(storage, key) {
			if (key === undefined) { return store.getAll() }
			key = ieKeyFix(key)
			return store.deserialize(storage.getAttribute(key))
		})
		store.remove = withIEStorage(function(storage, key) {
			key = ieKeyFix(key)
			storage.removeAttribute(key)
			storage.save(localStorageName)
		})
		store.clear = withIEStorage(function(storage) {
			var attributes = storage.XMLDocument.documentElement.attributes
			storage.load(localStorageName)
			for (var i=0, attr; attr=attributes[i]; i++) {
				storage.removeAttribute(attr.name)
			}
			storage.save(localStorageName)
		})
		store.setAll = withIEStorage(function(storage, vals) {
			for (var i in vals) {
				vals[i] = store.set(i, vals[i])
			}
			return vals
		})
		store.getAll = withIEStorage(function(storage) {
			var attributes = storage.XMLDocument.documentElement.attributes
			storage.load(localStorageName)
			var ret = {}
			for (var i=0, attr; attr=attributes[i]; ++i) {
				ret[attr] = store.get(attr)
			}
			return ret
		})
	}

	try {
		store.set(namespace, namespace)
		if (store.get(namespace) != namespace) { store.disabled = true }
		store.remove(namespace)
	} catch(e) {
		store.disabled = true
	}
	store.enabled = !store.disabled

	if (typeof module != 'undefined' && typeof module != 'function') { module.exports = store }
	else if (typeof define === 'function' && define.amd) { define('module/../../../lib/store/store',store) }
	else { this.store = store }
})();
/**
 * # util/util
 *
 * This is the home for wayward methods who have lost their way.
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('util/util',[
    "jquery"
],
function ($) {

    "use strict";

    // **Module definition**
    return {
        /**
         * ### util.inherit
         * Set up prototypical inheritance
         *
         * @param {function} Child Constructor
         * @param {function} Parent Constructor
         * @param {object} methods To add to Child.prototype
         */
        inherit: function (Child, Parent, methods) {
            Child.prototype = new Parent();
            Child.prototype.constructor = Parent;

            $.each(methods, function (name, method) {
                Child.prototype[name] = method;
            });

            Child.prototype._super = function (name, context, args) {
                var method = Parent.prototype[name];

                return method.apply(context, args);
            };
        },

        /**
         * ### util.debounce
         * Prevent a function from being called more than once within
         * a certain threshold
         *
         * @param {function} func Function to modify
         * @param {number} threshold In ms
         * @param {boolean} execAsap If true, run function on first call
         * @return function
         */
        debounce: function (func, threshold, execAsap) {
            var timeout;

            return function () {
                var context = this;
                var args = arguments;

                var delayed = function () {
                    if (!execAsap) {
                        func.apply(context, args);
                    }

                    timeout = null;
                };

                if (timeout) {
                    window.clearTimeout(timeout);
                } else if (execAsap) {
                    func.apply(context, args);
                }

                timeout = setTimeout(delayed, threshold || 50);
            };
        },

        /**
         * ### util.dataToObjectURL
         * Convert base64 data or raw binary data to an object URL
         * See: http://stackoverflow.com/a/5100158/230483
         *
         * @param {string} dataURI
         * @return string
         */
        dataToObjectURL: function (dataURI) {
            var dataParts = dataURI.split(',');
            var byteString;

            // convert base64 to raw binary data held in a string
            if (dataParts[0].indexOf('base64') >= 0) {
                byteString = atob(dataParts[1]);
            } else {
                byteString = decodeURIComponent(dataParts[1]);
            }

            // separate out the mime component
            var mimeString = dataParts[0].split(':')[1].split(';')[0];

            // write the bytes of the string to an ArrayBuffer
            var bl = byteString.length;
            var ab = new ArrayBuffer(bl);
            var ia = new Uint8Array(ab);
            var i;
            for (i = 0; i < bl; i++) {
                ia[i] = byteString.charCodeAt(i);
            }

            // get the blob and create an object URL
            var blob = this.createBlob(ab, mimeString);
            var url = this.createObjectURL(blob);

            return url;
        },

        /**
         * ### util.createBlob
         * Polyfill
         */
        createBlob: function (arrayBuffer, mimeString) {
            var BlobBuilder = window.BlobBuilder || window.WebKitBlobBuilder;

            if (!BlobBuilder) {
                throw new Error("BlobBuilder is unsupported.");
            }

            var bb = new BlobBuilder();
            bb.append(arrayBuffer);

            return bb.getBlob(mimeString);
        },

        /**
         * ### util.createObjectURL
         * Polyfill
         */
        createObjectURL: function (file) {
            if (window.URL && window.URL.createObjectURL) {
                return window.URL.createObjectURL(file);
            }

            if (window.webkitURL && window.webkitURL.createObjectURL) {
                return window.webkitURL.createObjectURL(file);
            }

            throw new Error("createObjectURL is unsupported.");
        }
    };

});
/**
 * # layout/base
 *
 * Base constructor for the canvas layout managers
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('layout/base',[
    "jquery"
],
function ($) {

    "use strict";

    var defaults = {
        maxPass: 2
    };

    /**
     * ## BaseLayout
     *
     * Create a new `BaseLayout` instance
     *
     * @constructor
     * @param {object} options
     */
    var BaseLayout = function (options) {
        this.settings = $.extend({}, defaults, options);
    };

    BaseLayout.prototype = {
        constructor: BaseLayout,

        /**
         * ### BaseLayout.prototype.getDimensions
         * ...
         */
        getDimensions: function () {},

        /**
         * ### BaseLayout.prototype.getDimensions
         * ...
         */
        placeSprites: function () {},

        /**
         * ### BaseLayout.prototype.getDimensions
         * ...
         */
        intersection: function (sprite, obstacles) {
            var x1, x2, y1, y2;
            var intersections = [];
            var intersection;

            $.map(obstacles, function (obstacle) {
                x1 = (obstacle.x < sprite.x + sprite.width);
                x2 = (obstacle.x + obstacle.width > sprite.x);
                y1 = (obstacle.y < sprite.y + sprite.height);
                y2 = (obstacle.y + obstacle.height > sprite.y);

                if (x1 && x2 && y1 && y2) {
                    intersections.push(obstacle);
                }
            });

            if (intersections.length) {
                intersection = intersections.pop();
            }

            return intersection;
        }
    };

    return BaseLayout;

});
/**
 * # layout/compact
 *
 * Constructor for the compact canvas layout manager
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('layout/compact',[
    "jquery",
    "util/util",
    "layout/base"
],
function ($, util, BaseLayout) {

    "use strict";

    var defaults = {
        maxPass: 2
    };

    /**
     * ## CompactLayout
     *
     * Create a new `CompactLayout` instance
     *
     * @constructor
     * @param {object} options
     */
    var CompactLayout = function (options) {
        this.settings = $.extend({}, defaults, options);
    };

    util.inherit(CompactLayout, BaseLayout, {
        /**
         * ### CompactLayout.prototype.getDimensions
         * ...
         */
        getDimensions: function (sprites, defaults) {
            var width = 0;
            var height = 0;
            var area = 0;
            var mean = 0;

            $.map(sprites, function (sprite) {
                width = sprite.width > width ? sprite.width : width;
                height = sprite.height > height ? sprite.height : height;
                area += sprite.area;
            });

            mean = Math.ceil(Math.sqrt(area));
            width = width > mean ? width : mean;
            height = height > mean ? height : mean;

            return {
                width: width || defaults.width,
                height: height || defaults.height
            };
        },

        /**
         * ### CompactLayout.prototype.getDimensions
         * ...
         */
        placeSprite: function (sprite, placed, dimensions) {
            var intersection;
            var pass = 0;
            var x = 0;
            var y = 0;

            while (pass++ < this.settings.maxPass) {
                for (y = 0; y <= dimensions.height - sprite.height; y++) {
                    for (x = 0; x <= dimensions.width - sprite.width; x++) {
                        sprite.x = x;
                        sprite.y = y;

                        intersection = this.intersection(sprite, placed);

                        if (!intersection) {
                            placed.push(sprite);
                            sprite.show();
                            return true;
                        }

                        x = intersection.x + intersection.width - 1;
                    }

                    y = intersection.y + intersection.height - 1;
                }

                dimensions.width += sprite.width;
                dimensions.height += sprite.height;
            }
        }
    });

    return CompactLayout;

});

/**
 * # layout/vertical
 *
 * Constructor for the vertical canvas layout manager
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('layout/vertical',[
    "jquery",
    "util/util",
    "layout/base"
],
function ($, util, BaseLayout) {

    "use strict";

    var defaults = {
        maxPass: 2
    };

    /**
     * ## VerticalLayout
     *
     * Create a new `VerticalLayout` instance
     *
     * @constructor
     * @param {object} options
     */
    var VerticalLayout = function (options) {
        this.settings = $.extend({}, defaults, options);
    };

    util.inherit(VerticalLayout, BaseLayout, {
        /**
         * ### VerticalLayout.prototype.getDimensions
         * ...
         */
        getDimensions: function (sprites, defaults) {
            var width = 0;
            var height = 0;

            $.map(sprites, function (sprite) {
                width = sprite.width > width ? sprite.width : width;
                height += sprite.height;
            });

            return {
                width: width || defaults.width,
                height: height || defaults.height
            };
        },

        /**
         * ### VerticalLayout.prototype.getDimensions
         * ...
         */
        placeSprite: function (sprite, placed, dimensions) {
            var intersection;
            var pass = 0;
            var x = 0;
            var y = 0;

            while (pass++ < this.settings.maxPass) {
                for (y = 0; y <= dimensions.height - sprite.height; y++) {
                    sprite.x = x;
                    sprite.y = y;

                    intersection = this.intersection(sprite, placed);

                    if (!intersection) {
                        placed.push(sprite);
                        sprite.show();
                        return true;
                    }

                    y = intersection.y + intersection.height - 1;
                }

                dimensions.width += sprite.width;
                dimensions.height += sprite.height;
            }

            return false;
        }
    });

    return VerticalLayout;

});

/**
 * # layout/horizontal
 *
 * Constructor for the horizontal canvas layout manager
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('layout/horizontal',[
    "jquery",
    "util/util",
    "layout/base"
],
function ($, util, BaseLayout) {

    "use strict";

    var defaults = {
        maxPass: 2
    };

    /**
     * ## HorizontalLayout
     *
     * Create a new `HorizontalLayout` instance
     *
     * @constructor
     * @param {object} options
     */
    var HorizontalLayout = function (options) {
        this.settings = $.extend({}, defaults, options);
    };

    util.inherit(HorizontalLayout, BaseLayout, {
        /**
         * ### HorizontalLayout.prototype.getDimensions
         * ...
         */
        getDimensions: function (sprites, defaults) {
            var width = 0;
            var height = 0;

            $.map(sprites, function (sprite) {
                height = sprite.height > height ? sprite.height : height;
                width += sprite.width;
            });

            return {
                width: width || defaults.width,
                height: height || defaults.height
            };
        },

        /**
         * ### HorizontalLayout.prototype.getDimensions
         * ...
         */
        placeSprite: function (sprite, placed, dimensions) {
            var intersection;
            var pass = 0;
            var x = 0;
            var y = 0;

            while (pass++ < this.settings.maxPass) {
                for (x = 0; x <= dimensions.width - sprite.width; x++) {
                    sprite.x = x;
                    sprite.y = y;

                    intersection = this.intersection(sprite, placed);

                    if (!intersection) {
                        placed.push(sprite);
                        sprite.show();
                        return true;
                    }

                    x = intersection.x + intersection.width - 1;
                }

                dimensions.width += sprite.width;
                dimensions.height += sprite.height;
            }

            return false;
        }
    });

    return HorizontalLayout;

});

/**
 * # util/layout
 *
 * Utility methods for setting the canvas layout
 * and stitching the sprites together (i.e. placing them
 * on the canvas)
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('util/layout',[
    "jquery",
    "layout/compact",
    "layout/vertical",
    "layout/horizontal"
],
function ($, CompactLayout, VerticalLayout, HorizontalLayout) {

    "use strict";

    // **Canvas layout constructors**
    var layouts = {
        compact: CompactLayout,
        vertical: VerticalLayout,
        horizontal: HorizontalLayout
    };

    // **Module definition**
    return {
        /**
         * ### stitches.setLayout
         * Set the working layout manager instance by type
         *
         * @param {string} type The layout manager type
         */
        setLayout: function (type) {
            var Constructor = layouts[type] || layouts.compact;

            this.layout = new Constructor();
        },

        /**
         * ### stitches.getDimensions
         * Get the dimensions necessary to place the sprites
         *
         * @param {array} sprites A list of sprites to place
         * @param {object} defaults Default dimensions if no sprites
         * @return object
         */
        getDimensions: function (sprites, defaults) {
            return this.layout.getDimensions(sprites, defaults);
        },

        /**
         * ### stitches.placeSprites
         * Position a list of sprites to fit in dimensions and layout
         *
         * @param {array} sprites To place
         * @param {array} placed Already placed
         * @param {object} dimensions Working width and height
         * @param {function} progress Function to update display on progress
         */
        placeSprites: function (sprites, placed, dimensions, progress) {
            var self = this;

            progress(0, "info");

            $.map(sprites, function (sprite) {
                if (!sprite.placed) {
                    sprite.placed = self.layout.placeSprite(sprite, placed, dimensions);
                }

                progress(placed.length / sprites.length);
            });

            sprites = $.map(sprites, function (sprite) {
                return sprite.placed ? null : sprite;
            });
        },

        /**
         * ### stitches.trim
         * Trim dimensions to only contain placed sprites
         *
         * @param {array} sprites A list of sprites
         * @param {object} dimensions Working width and height
         */
        trim: function (sprites, dimensions) {
            var w = 0;
            var h = 0;

            $.map(sprites, function (sprite) {
                w = w > sprite.x + sprite.width ? w : sprite.x + sprite.width;
                h = h > sprite.y + sprite.height ? h : sprite.y + sprite.height;
            });

            dimensions.width = w || dimensions.width;
            dimensions.height = h || dimensions.height;
        },

        /**
         * ### stitches.makeSpritesheet
         * Make an image using the browser canvas element's drawing context.
         * Triggers a non-fatal error if anything fails
         *
         * @param {array} sprites A list of sprites
         * @param {object} dimensions Working width and height
         * @return string
         */
        makeSpritesheet: function (sprites, dimensions) {
            var canvas;
            var context;
            var spritesheet;

            canvas = document.createElement("canvas");
            canvas.width = dimensions.width;
            canvas.height = dimensions.height;

            try {
                context = canvas.getContext("2d");

                $.map(sprites, function (sprite) {
                    var x = sprite.left();
                    var y = sprite.top();

                    context.drawImage(sprite.image, x, y);
                });

                spritesheet = canvas.toDataURL("image/png");
            } catch (e) {
                this.$element.trigger("error", [e]);
            }

            return spritesheet;
        },

        /**
         * ### stitches.makeStylesheet
         * Make a stylesheet to place images with spritesheet
         *
         * @param {array} sprites A list of sprites
         * @param {string} spritesheet The data URL of the spritesheet
         * @param {string} prefix Used to create CSS classes
         * @param {boolean} uri Switch including image as data URI
         * @param {string} style Either CSS or Less
         * @return string
         */
        makeStylesheet: function (sprites, spritesheet, prefix, uri, style) {
            var backgroundImage = uri ? spritesheet : "download.png";
            var styles;
            var stylesheet;

            sprites = sprites.sort(function (a, b) {
                return a.name < b.name ? -1 : 1;
            });

            switch (style) {
            case "less":
                styles = this.makeStylesLESS(sprites, prefix, backgroundImage);
                break;
            case "css":
                styles = this.makeStylesCSS(sprites, prefix, backgroundImage);
                break;
            default:
                break;
            }

            stylesheet = "data:text/plain," + encodeURIComponent(styles.join("\n"));

            return stylesheet;
        },

        /**
         * ### stitches.makeStylesCSS
         * Make a CSS styles
         *
         * @param {array} sprites A list of sprites
         * @param {string} prefix Used to create CSS classes
         * @param {string} backgroundImage Used for the main sprite class
         * @return string
         */
        makeStylesCSS: function (sprites, prefix, backgroundImage) {
            var styles = [
                "." + prefix + " {",
                "    background: url(" + backgroundImage + ") no-repeat;",
                "}\n"
            ];

            $.map(sprites, function (sprite) {
                styles = styles.concat([
                    "." + prefix + "-" + sprite.name + " {",
                    "    width: " + sprite.image.width + "px;",
                    "    height: " + sprite.image.height + "px;",
                    "    background-position: -" + sprite.left() + "px -" + sprite.top() + "px;",
                    "}\n"
                ]);
            });

            return styles;
        },

        /**
         * ### stitches.makeStylesLESS
         * Make a LESS styles
         *
         * @param {array} sprites A list of sprites
         * @param {string} prefix Used to create CSS classes
         * @param {string} backgroundImage Used for the main sprite class
         * @return string
         */
        makeStylesLESS: function (sprites, prefix, backgroundImage) {
            var styles = [
                "." + prefix + " (@x: 0, @y: 0, @width: 0, @height: 0) {",
                "    background: url(" + backgroundImage + ") @x @y no-repeat;",
                "    display: block;",
                "    width: @width;",
                "    height: @height;",
                "}\n"
            ];

            $.map(sprites, function (sprite) {
                styles = styles.concat([
                    "." + prefix + "-" + sprite.name + " {",
                    " .sprite(-" + sprite.left() + "px, -" + sprite.top() + "px, " + sprite.image.width + "px, " + sprite.image.height + "px); ",
                    "}\n"
                ]);
            });

            return styles;
        }

    };

});
/**
 * Adapted from the official plugin text.js
 *
 * Uses UnderscoreJS micro-templates : http://documentcloud.github.com/underscore/#template
 * @author Julien Cabanès <julien@zeeagency.com>
 * @version 0.2
 *
 * @license RequireJS text 0.24.0 Copyright (c) 2010-2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
/*jslint regexp: false, nomen: false, plusplus: false, strict: false */
/*global require: false, XMLHttpRequest: false, ActiveXObject: false,
  define: false, window: false, process: false, Packages: false,
  java: false */

(function () {
//>>excludeStart('excludeTpl', pragmas.excludeTpl)
    var progIds = ['Msxml2.XMLHTTP', 'Microsoft.XMLHTTP', 'Msxml2.XMLHTTP.4.0'],

        xmlRegExp = /^\s*<\?xml(\s)+version=[\'\"](\d)*.(\d)*[\'\"](\s)*\?>/im,

        bodyRegExp = /<body[^>]*>\s*([\s\S]+)\s*<\/body>/im,

        buildMap = [],

        templateSettings = {
            evaluate    : /<%([\s\S]+?)%>/g,
            interpolate : /<%=([\s\S]+?)%>/g
        },

        /**
         * JavaScript micro-templating, similar to John Resig's implementation.
         * Underscore templating handles arbitrary delimiters, preserves whitespace,
         * and correctly escapes quotes within interpolated code.
         */
        template = function(str, data) {
            var c  = templateSettings;
            var tmpl = 'var __p=[],print=function(){__p.push.apply(__p,arguments);};' +
                'with(obj||{}){__p.push(\'' +
                str.replace(/\\/g, '\\\\')
                    .replace(/'/g, "\\'")
                    .replace(c.interpolate, function(match, code) {
                    return "'," + code.replace(/\\'/g, "'") + ",'";
                    })
                    .replace(c.evaluate || null, function(match, code) {
                    return "');" + code.replace(/\\'/g, "'")
                                        .replace(/[\r\n\t]/g, ' ') + "; __p.push('";
                    })
                    .replace(/\r/g, '')
                    .replace(/\n/g, '')
                    .replace(/\t/g, '')
                    + "');}return __p.join('');";
            return tmpl;

            /** /
            var func = new Function('obj', tmpl);
            return data ? func(data) : func;
            /**/
        };
//>>excludeEnd('excludeTpl')

    define('tpl',[],function () {
//>>excludeStart('excludeTpl', pragmas.excludeTpl)
        var tpl;

        var get, fs;
        if (typeof window !== "undefined" && window.navigator && window.document) {
            get = function (url, callback) {

                var xhr = tpl.createXhr();
                xhr.open('GET', url, true);
                xhr.onreadystatechange = function (evt) {
                    //Do not explicitly handle errors, those should be
                    //visible via console output in the browser.
                    if (xhr.readyState === 4) {
                        callback(xhr.responseText);
                    }
                };
                xhr.send(null);
            };
        } else if (typeof process !== "undefined" &&
                process.versions &&
                !!process.versions.node) {
            //Using special require.nodeRequire, something added by r.js.
            fs = require.nodeRequire('fs');

            get = function (url, callback) {

                callback(fs.readFileSync(url, 'utf8'));
            };
        }
        return tpl = {
            version: '0.24.0',
            strip: function (content) {
                //Strips <?xml ...?> declarations so that external SVG and XML
                //documents can be added to a document without worry. Also, if the string
                //is an HTML document, only the part inside the body tag is returned.
                if (content) {
                    content = content.replace(xmlRegExp, "");
                    var matches = content.match(bodyRegExp);
                    if (matches) {
                        content = matches[1];
                    }
                } else {
                    content = "";
                }

                return content;
            },

            jsEscape: function (content) {
                return content.replace(/(['\\])/g, '\\$1')
                    .replace(/[\f]/g, "\\f")
                    .replace(/[\b]/g, "\\b")
                    .replace(/[\n]/g, "")
                    .replace(/[\t]/g, "")
                    .replace(/[\r]/g, "");
            },

            createXhr: function () {
                //Would love to dump the ActiveX crap in here. Need IE 6 to die first.
                var xhr, i, progId;
                if (typeof XMLHttpRequest !== "undefined") {
                    return new XMLHttpRequest();
                } else {
                    for (i = 0; i < 3; i++) {
                        progId = progIds[i];
                        try {
                            xhr = new ActiveXObject(progId);
                        } catch (e) {}

                        if (xhr) {
                            progIds = [progId];  // so faster next time
                            break;
                        }
                    }
                }

                if (!xhr) {
                    throw new Error("require.getXhr(): XMLHttpRequest not available");
                }

                return xhr;
            },

            get: get,

            load: function (name, req, onLoad, config) {

                //Name has format: some.module.filext!strip
                //The strip part is optional.
                //if strip is present, then that means only get the string contents
                //inside a body tag in an HTML string. For XML/SVG content it means
                //removing the <?xml ...?> declarations so the content can be inserted
                //into the current doc without problems.

                var strip = false, url, index = name.indexOf("."),
                    modName = name.substring(0, index),
                    ext = name.substring(index + 1, name.length);

                index = ext.indexOf("!");

                if (index !== -1) {
                    //Pull off the strip arg.
                    strip = ext.substring(index + 1, ext.length);
                    strip = strip === "strip";
                    ext = ext.substring(0, index);
                }

                //Load the tpl.
                url = 'nameToUrl' in req ? req.nameToUrl(modName, "." + ext) : req.toUrl(modName + "." + ext);

                tpl.get(url, function (content) {
                    content = template(content);

                    if(!config.isBuild) {
                    //if(typeof window !== "undefined" && window.navigator && window.document) {
                        content = new Function('obj', content);
                    }
                    content = strip ? tpl.strip(content) : content;

                    if (config.isBuild && config.inlineText) {
                        buildMap[name] = content;
                    }
                    onLoad(content);
                });

            },

            write: function (pluginName, moduleName, write) {
                if (moduleName in buildMap) {
                    var content = tpl.jsEscape(buildMap[moduleName]);
                    write("define('" + pluginName + "!" + moduleName  +
                        "', function() {return function(obj) { " +
                            content.replace(/(\\')/g, "'").replace(/(\\\\)/g, "\\")+
                        "}});\n");
                }
            }
        };
//>>excludeEnd('excludeTpl')
        return function() {};
    });
//>>excludeEnd('excludeTpl')
}());
define('tpl!util/../../templates/stitches.html', function() {return function(obj) { var __p=[],print=function(){__p.push.apply(__p,arguments);};with(obj||{}){__p.push('<div class="stitches">    <!-- .stitches-toolbar -->    <div class="stitches-toolbar btn-toolbar">        <div class="btn-group shrink">            <a href="http://draeton.github.com/stitches/" class="btn btn-small btn-link">                <strong>Stitches</strong>            </a>            <button data-action="open" class="btn btn-small btn-info files" title="Open">                <i class="icon-folder-open icon-white"></i> <span>Open</span><input class="file" type="file" multiple="">            </button>            <button data-action="settings" class="btn btn-small btn-info" title="Set layout, style prefix, padding, etc.">                <i class="icon-cog icon-white"></i> <span>Settings</span>            </button>            <button data-action="generate" class="btn btn-small btn-info disabled" title="Generate spritesheet and stylesheet">                <i class="icon-tasks icon-white"></i> <span>Generate</span>            </button>            <button data-action="clear" class="btn btn-small btn-info disabled" title="Clear sprites from the canvas">                <i class="icon-remove icon-white"></i> <span>Clear</span>            </button>        </div>        <div class="btn-group shrink">            <a href="#" data-action="spritesheet" class="btn btn-small btn-success disabled" title="Open the spritesheet in a new tab" target="_blank">                <i class="icon-download-alt icon-white"></i> <span>Spritesheet</span>            </a>            <a href="#" data-action="stylesheet" class="btn btn-small btn-success disabled" title="Open the stylesheet in a new tab" target="_blank">                <i class="icon-download-alt icon-white"></i> <span>Stylesheet</span>            </a>        </div>        <div class="btn-group shrink">            <button data-action="about" class="btn btn-small btn-info" title="About Stitches">                <i class="icon-info-sign icon-white"></i> <span>About</span>            </button>        </div>    </div>    <!-- /.stitches-toolbar -->    <!-- .stitches-progress -->    <div class="stitches-progress collapse">        <div class="progress progress-warning">            <div class="bar" style="width: 0%;"></div>        </div>    </div>    <!-- /.stitches-progress -->    <!-- .stitches-drop-box -->    <div class="stitches-drop-box">        <div class="stitches-overlay"></div>        <div class="stitches-wrap">            <!-- .stitches-canvas -->            <div class="stitches-canvas"></div>            <!-- /.stitches-canvas -->        </div>        <!-- .stitches-palettes -->        <div class="stitches-palettes">            <!-- .stitches-settings -->            <div class="stitches-palette stitches-settings fade">                <div class="stitches-palette-header">                    <button type="button" class="close" data-action="close" title="Close">&times;</button>                    <h4>Settings</h4>                </div>                <div class="stitches-palette-body">                    <form class="form-horizontal">                        <div class="control-group hide">                            <label class="control-label">Position</label>                            <div class="controls">                                <label class="checkbox">                                    <input name="position" type="checkbox" value="auto"/> Auto                                </label>                            </div>                        </div>                        <div class="control-group">                            <label class="control-label">Layout</label>                            <div class="controls">                                <label class="radio inline">                                    <input name="layout" type="radio" value="compact"/> Compact                                </label>                                <label class="radio inline">                                    <input name="layout" type="radio" value="vertical"/> Vertical                                </label>                                <label class="radio inline">                                    <input name="layout" type="radio" value="horizontal"/> Horizontal                                </label>                            </div>                        </div>                        <div class="control-group">                            <label class="control-label">CSS/LESS</label>                            <div class="controls">                                <label class="radio inline">                                    <input name="style" type="radio" value="css"/> CSS                                </label>                                <label class="radio inline">                                    <input name="style" type="radio" value="less"/> LESS                                </label>                            </div>                        </div>                        <div class="control-group">                            <label class="control-label">Style prefix</label>                            <div class="controls">                                <input name="prefix" type="text" placeholder="Style class prefix&hellip;">                            </div>                        </div>                        <div class="control-group">                            <label class="control-label">Padding</label>                            <div class="controls">                                <div class="input-append">                                    <input name="padding" type="number" min="0" required placeholder="Sprite padding&hellip;">                                    <span class="add-on">px</span>                                </div>                            </div>                        </div>                        <div class="control-group">                            <label class="control-label">Data URI</label>                            <div class="controls">                                <label class="checkbox">                                    <input name="uri" type="checkbox" value="true"/> Include encoded image in CSS                                </label>                            </div>                        </div>                    </form>                </div>                <div class="stitches-palette-footer">                    <div class="btn-toolbar">                        <div class="btn-group">                            <button class="btn btn-small btn-info" data-action="close" title="Save"><span>Save</span></button>                            <button class="btn btn-small btn-info" data-action="close" title="Close"><span>Close</span></button>                        </div>                    </div>                    <div class="clearfix"></div>                </div>            </div>            <!-- /.stitches-settings -->            <!-- .stitches-properties -->            <div class="stitches-palette stitches-properties fade">                <div class="stitches-palette-header">                    <button type="button" class="close" data-action="close" title="Close">&times;</button>                    <h4>Sprite Properties</h4>                </div>                <div class="stitches-palette-body">                    <form class="form-horizontal">                        <div class="control-group">                            <label class="control-label">Name</label>                            <div class="controls">                                <input name="name" type="text" required placeholder="Sprite name&hellip;">                            </div>                        </div>                        <div class="control-group">                            <label class="control-label">Coordinates (x, y)</label>                            <div class="controls">                                <div class="input-append">                                    <input name="x" required disabled placeholder="From left&hellip;" class="input-mini">                                    <span class="add-on">px</span>                                </div>                                <div class="input-append">                                    <input name="y" required disabled placeholder="From top&hellip;" class="input-mini">                                    <span class="add-on">px</span>                                </div>                            </div>                        </div>                    </form>                </div>                <div class="stitches-palette-footer">                    <div class="btn-toolbar">                        <div class="btn-group">                            <button class="btn btn-small btn-danger" data-action="remove" title="Delete"><span>Delete</span></button>                            <button class="btn btn-small btn-info" data-action="close" title="Save"><span>Save</span></button>                            <button class="btn btn-small btn-info" data-action="close" title="Close"><span>Close</span></button>                        </div>                    </div>                    <div class="clearfix"></div>                </div>            </div>            <!-- /.stitches-properties -->            <!-- .stitches-about -->            <div class="stitches-palette stitches-about fade in">                <div class="stitches-palette-header">                    <button type="button" class="close" data-action="close" title="Close">&times;</button>                    <h4>About Stitches</h4>                </div>                <div class="stitches-palette-body">                    <p><a href="http://draeton.github.com/stitches/">Stitches<a/> is an HTML5 <a href="http://en.wikipedia.org/wiki/Sprite_(computer_graphics)#Sprites_by_CSS">sprite sheet</a> generator.</p>                    <p>Drag &amp; drop image files onto the space below, or use the &ldquo;Open&rdquo; link to load images using the file browser. Then, click &ldquo;Generate&rdquo; to create a sprite sheet and stylesheet. <em>This demo uses a couple of HTML5 APIs, and it is only currently compatible with WebKit and Firefox browsers.</em></p>                    <p>Stitches is developed by <a href="http://draeton.github.com">Matthew Cobbs</a> in concert with the lovely open-source community at <a href="http://github.com">Github</a>. Thanks are owed to the developers at Twitter for <a href="http://twitter.github.com/bootstrap">Bootstrap</a>, and <a href="http://glyphicons.com/">Glyphicons</a> for some cool little icons.</p>                    <p>&copy; 2013, Matthew Cobbs<br/>                        Licensed under the MIT license.</p>                </div>                <div class="stitches-palette-footer">                    <div class="btn-toolbar">                        <div class="btn-group">                            <button class="btn btn-small btn-info" data-action="close" title="Close"><span>Close</span></button>                        </div>                    </div>                    <div class="clearfix"></div>                </div>            </div>            <!-- /.stitches-properties -->        </div>        <!-- /.stitches-palettes -->    </div>    <!-- /.stitches-drop-box --></div>');}return __p.join('');}});

define('tpl!util/../../templates/sprite.html', function() {return function(obj) { var __p=[],print=function(){__p.push.apply(__p,arguments);};with(obj||{}){__p.push('<div class="stitches-sprite" style="top: ',y,'px; left: ',x,'px;">    <img src="',image.src,'"/></div>');}return __p.join('');}});

/**
 * # util/templates
 *
 * Utility methods for referencing js templates
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('util/templates',[
    "tpl!../../templates/stitches.html",
    "tpl!../../templates/sprite.html"
],
function (stitchesTemplate, spriteTemplate) {

    "use strict";

    // **Module definition**
    return {
        /**
         * ### templates.stitches
         * Returns the `Stitches` template
         *
         * @return string
         */
        stitches: function () {
            return stitchesTemplate.apply(this, arguments);
        },

        /**
         * ### templates.sprite
         * Returns the `Sprite` template
         *
         * @return string
         */
        sprite: function () {
            return spriteTemplate.apply(this, arguments);
        }
    };

});
/**
 * # module/file-manager
 *
 * ...
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('module/file-manager',[
    "jquery",
    "util/util"
],
function($, util) {

    "use strict";

    var defaults = {
        progress: function () {}
    };

    /**
     * ## FileManager
     *
     * Create a new `FileManager` instance
     *
     * @constructor
     * @param {element} element
     * @param {object} options
     */
    var FileManager = function (element, options) {
        this.$element = $(element);
        this.settings = $.extend({}, defaults, options);
        this.progress = this.settings.progress;
        this.total = 0;
        this.processed = 0;

        this.init();
    };

    FileManager.prototype = {
        constructor: FileManager,

        /**
         * ### FileManager.prototype.init
         * ...
         */
        init: function () {},

        /**
         * ### FileManager.prototype.processFiles
         * ...
         */
        processFiles: function (files) {
            var self = this;

            this.total = files.length;
            this.processed = 0;

            $.map(files, function (file) {
                if (/jpeg|png|gif/.test(file.type)) {
                    self.processFile(file);
                }
            });

            this.progress(0, "info");
        },

        /**
         * ### FileManager.prototype.processFile
         * ...
         */
        processFile: function (file) {
            var self = this;
            var reader;

            try {
                reader = new FileReader();
                reader.onloadend = function (e) {
                    var name = file.name;
                    var src = e.target.result;

                    self.$element.trigger("create-sprite", [name, src]);
                    self.progress(++self.processed / self.total);
                };
                reader.readAsDataURL(file);
            } catch (e) {
                this.$element.trigger("error", [e]);
            }
        }
    };

    return FileManager;

});
/**
 * # module/drop-box
 *
 * ...
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('module/drop-box',[
    "jquery",
    "util/util"
],
function($, util) {

    "use strict";

    var defaults = {};

    /**
     * ## DropBox
     *
     * Create a new `DropBox` instance
     *
     * @constructor
     * @param {element} element
     * @param {object} options
     */
    var DropBox = function (element, options) {
        this.$element = $(element);
        this.$overlay = this.$element.find(".stitches-overlay");
        this.settings = $.extend({}, defaults, options);

        this.init();
    };

    DropBox.classname = ".stitches-drop-box";

    DropBox.prototype = {
        constructor: DropBox,

        /**
         * ### DropBox.prototype.init
         * ...
         */
        init: function () {
            this.bind();
        },

        /**
         * ### DropBox.prototype.bind
         * ...
         */
        bind: function () {
            var dropBox = this.$element.get(0);
            var overlay = this.$overlay.get(0);

            dropBox.addEventListener("dragenter", $.proxy(this.dragStart, this), false);
            overlay.addEventListener("dragleave", $.proxy(this.dragStop, this), false);
            overlay.addEventListener("dragexit", $.proxy(this.dragStop, this), false);
            overlay.addEventListener("dragover", this.noop, false);
            overlay.addEventListener("drop", $.proxy(this.drop, this), false);
        },

        /**
         * ### DropBox.prototype.noop
         * ...
         */
        noop: function (e) {
            e.preventDefault();
            e.stopPropagation();
        },

        /**
         * ### DropBox.prototype.dragStart
         * ...
         */
        dragStart: function (e) {
            this.$element.trigger("close-palettes");
            this.$element.trigger("show-overlay");
        },

        /**
         * ### DropBox.prototype.dragStop
         * ...
         */
        dragStop: function (e) {
            if ($.contains(this.$element, e.target)) {
                this.$element.trigger("hide-overlay");
            }
        },

        /**
         * ### DropBox.prototype.drop
         * ...
         */
        drop: function (e) {
            var files = (e.files || e.dataTransfer.files);

            e.stopPropagation();
            e.preventDefault();

            if (files.length) {
                this.$element.trigger("process-files", [files]);
            } else {
                this.$element.trigger("hide-overlay");
            }
        }
    };

    return DropBox;

});
/**
 * # util/array
 *
 * Utility methods for working with arrays
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('util/array',[
    "jquery"
],
function ($) {

    "use strict";

    // **Module definition**
    return {
        /**
         * ### array.remove
         * Remove from an array by value
         *
         * @param {array} list The array to filter
         * @param {*} value Any items matching value are removed
         * @return array
         */
        remove: function (array, value) {
            return $(array).filter(function () {
                return this !== value;
            });
        }
    };

});
/**
 * # module/sprite
 *
 * ...
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('module/sprite',[
    "jquery",
    "util/util",
    "util/templates"
],
function($, util, templates) {

    "use strict";

    var defaults = {
        name: "",
        src: "",
        padding: 0,
        callback: null
    };

    /**
     * ## Sprite
     *
     * Create a new `Sprite` instance
     *
     * @constructor
     * @param {element} element
     * @param {object} options
     */
    var Sprite = function (options) {
        this.settings = $.extend({}, defaults, options);
        this.$element = null;
        this.name = this.cleanName(this.settings.name);
        this.src = this.settings.src;
        this.padding = parseInt(this.settings.padding, 10);
        this.callback = this.settings.callback;
        this.active = false;
        this.placed = false;

        this.init();
    };

    Sprite.classname = ".stitches-sprite";

    Sprite.prototype = {
        constructor: Sprite,

        /**
         * ### Sprite.prototype.init
         * ...
         */
        init: function () {
            this.load();
        },

        /**
         * ### Sprite.prototype.load
         * ...
         */
        load: function () {
            var self = this;

            this.image = new Image();
            this.image.onload = function () {
                self.x = 0;
                self.y = 0;
                self.width = self.image.width + self.padding * 2;
                self.height = self.image.height + self.padding * 2;
                self.area = self.width * self.height;
                self.render();
                self.bind();

                if (self.callback) {
                    self.callback(self);
                }
            };

            this.image.src = this.src;
        },

        /**
         * ### Sprite.prototype.render
         * ...
         */
        render: function () {
            var html = templates.sprite(this);

            this.$element = $(html);
            this.$element.data("sprite", this);
        },

        /**
         * ### Sprite.prototype.bind
         * ...
         */
        bind: function () {
            this.$element.on("click", $.proxy(this.click, this));
        },

        /**
         * ### Sprite.prototype.reset
         * ...
         */
        reset: function () {
            this.x = 0;
            this.y = 0;
            this.placed = false;
            this.$element.removeClass("placed");
        },

        /**
         * ### Sprite.prototype.show
         * ...
         */
        show: function () {
            this.$element.css({
                left: this.x + "px",
                top: this.y + "px",
                padding: this.padding + "px"
            }).addClass("placed");
        },

        /**
         * ### Sprite.prototype.click
         * ...
         */
        click: function (e) {
            this.active = !this.active;

            if (this.active) {
                this.$element.trigger("clear-active", [this]);
                this.$element.trigger("open-properties", [this]);
            } else {
                this.$element.trigger("close-properties");
            }

            this.$element.toggleClass("active");
        },

        /**
         * ### Sprite.prototype.configure
         * ...
         */
        configure: function (properties) {
            if (properties.padding) {
                this.padding = parseInt(properties.padding, 10);
                this.width = this.image.width + this.padding * 2;
                this.height = this.image.height + this.padding * 2;
                this.area = this.width * this.height;
            }
        },

        /**
         * ### Sprite.prototype.cleanName
         * Remove special characters and other markers from a string
         * to be used as a sprite name
         *
         * @param {string} name The name of the sprite
         * @return string
         */
        cleanName: function (name) {
            name = name.replace(/\.\w+$/i, ""); // file extension
            name = name.replace(/[\s.]+/gi, "-"); // spaces to -
            name = name.replace(/[^a-z0-9\-]/gi, "_"); // other to _

            return name;
        },

        /**
         * ### Sprite.prototype.left
         * Returns the x position of the sprite accounting for padding
         *
         * @return number
         */
        left: function () {
            return this.x + this.padding;
        },

        /**
         * ### Sprite.prototype.top
         * Returns the y position of the sprite accounting for padding
         *
         * @return number
         */
        top: function () {
            return this.y + this.padding;
        }
    };

    return Sprite;

});
/**
 * # module/canvas
 *
 * ...
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('module/canvas',[
    "jquery",
    "util/util",
    "util/array",
    "util/layout",
    "module/sprite"
],
function($, util, array, layout, Sprite) {

    "use strict";

    var defaults = {
        images: null,
        dimensions: {
            width: 400,
            height: 400
        },
        progress: function () {}
    };

    /**
     * ## Canvas
     *
     * Create a new `Canvas` instance
     *
     * @constructor
     * @param {element} element
     * @param {object} options
     */
    var Canvas = function (element, options) {
        this.$element = $(element);
        this.settings = $.extend({}, defaults, options);
        this.images = this.settings.images;
        this.dimensions = this.settings.dimensions;
        this.progress = this.settings.progress;
        this.sprites = [];
        this.spritesheet = null;
        this.stylesheet = null;

        this.init();
    };

    Canvas.classname = ".stitches-canvas";

    Canvas.prototype = {
        constructor: Canvas,

        /**
         * ### Canvas.prototype.init
         * ...
         */
        init: function () {
            this.reset = util.debounce(this.reset, 500);
            this.bind();
            this.setup();
            this.reset();
        },

        /**
         * ### Canvas.prototype.bind
         * ...
         */
        bind: function () {
            this.$element.on("create-sprite", $.proxy(this.createSprite, this));
            this.$element.on("clear-active", $.proxy(this.clearActive, this));
        },

        /**
         * ### Canvas.prototype.setup
         * ...
         */
        setup: function () {
            var self = this;

            $(this.images).each(function () {
                var $img = $(this);
                var name = $img.data("name");
                var src = $img.attr("src");

                self.$element.trigger("create-sprite", [name, src]);
            }).remove();
        },

        /**
         * ### Canvas.prototype.reset
         * ...
         */
        reset: function () {
            this.$element.trigger("show-overlay");
            this.measure(this.sprites);
            this.place(this.sprites);
            this.cut(this.sprites);
            this.$element.trigger("generate-sheets");
            this.$element.trigger("hide-overlay");
        },

        /**
         * ### Canvas.prototype.measure
         * ...
         */
        measure: function (sprites) {
            this.dimensions = layout.getDimensions(sprites, this.settings.dimensions);
        },

        /**
         * ### Canvas.prototype.place
         * ...
         */
        place: function (sprites) {
            var placed = [];

            $.map(sprites, function (sprite) {
                sprite.reset();
            });

            sprites = sprites.sort(function (a, b) {
                if (b.area === a.area) {
                    return b.name > a.name ? 1 : -1;
                } else {
                    return b.area - a.area;
                }
            });

            layout.placeSprites(sprites, placed, this.dimensions, this.progress);
        },

        /**
         * ### Canvas.prototype.cut
         * ...
         */
        cut: function (sprites) {
            layout.trim(sprites, this.dimensions);

            this.$element.css({
                width: this.dimensions.width + "px",
                height: this.dimensions.height + "px"
            });
        },

        /**
         * ### Canvas.prototype.add
         * ...
         */
        add: function (sprite) {
            this.$element.trigger("show-overlay");
            this.sprites.push(sprite);
            sprite.$element.appendTo(this.$element);
            this.$element.trigger("update-toolbar");

            this.reset();
        },

        /**
         * ### Canvas.prototype.remove
         * ...
         */
        remove: function (sprite) {
            this.$element.trigger("show-overlay");
            this.sprites = array.remove(this.sprites, sprite);
            sprite.$element.fadeOut("fast").remove();
            this.$element.trigger("update-toolbar");
            this.$element.trigger("close-properties");

            this.reset();
        },

        /**
         * ### Canvas.prototype.clear
         * ...
         */
        clear: function () {
            this.$element.trigger("show-overlay");
            this.sprites = [];
            this.$element.empty();
            this.$element.trigger("update-toolbar");
            this.$element.trigger("close-properties");
            this.$element.trigger("open-settings");

            this.reset();
        },

        /**
         * ### Canvas.prototype.clearActive
         * ...
         */
        clearActive: function (e, sprite) {
            this.$element.find(".active").each(function () {
                var $active = $(this);
                var active = $active.data("sprite");

                if (sprite && active !== sprite) {
                    $active.removeClass("active");
                    active.active = false;
                }
            });
        },

        /**
         * ### Canvas.prototype.createSprite
         * ...
         */
        createSprite: function (e, name, src) {
            var self = this;
            var sprite = new Sprite({
                name: name,
                src: src,
                padding: this.settings.padding,
                callback: function (sprite) {
                    self.add(sprite);
                }
            });
        }
    };

    return Canvas;

});
/**
 * # module/toolbar
 *
 * ...
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('module/toolbar',[
    "jquery"
],
function ($) {

    "use strict";

    var defaults = {
        name: "",
        actions: {}
    };

    /**
     * ## Toolbar
     *
     * Create a new `Toolbar` instance
     *
     * @constructor
     * @param {element} element
     * @param {object} options
     */
    var Toolbar = function (element, options) {
        this.$element = $(element);
        this.settings = $.extend({}, defaults, options);
        this.name = this.settings.name;
        this.actions = this.settings.actions;

        this.init();
    };

    Toolbar.classname = ".stitches-toolbar";

    Toolbar.prototype = {
        constructor: Toolbar,

        /**
         * ### Toolbar.prototype.init
         * ...
         */
        init: function () {
            this.bind();
        },

        /**
         * ### Toolbar.prototype.bind
         * ...
         */
        bind: function () {
            var self = this;

            $.each(this.actions, function (action, events) {
                $.each(events, function (event, callback) {
                    var selector = "[data-action=" + action + "]";
                    var handler = self.getHandler(self, callback);

                    if (action === "instance") {
                        self.$element.on(event, self.getHandler(self, handler));
                    } else {
                        self.$element.on(event, selector, handler);
                    }
                });
            });
        },

        /**
         * ### Toolbar.prototype.getHandler
         * ...
         */
        getHandler: function (context, callback) {
            return function (e) {
                var $target = $(e.currentTarget);

                if ($target.is(".disabled")) {
                    e.stopPropagation();
                    e.preventDefault();
                } else {
                    callback.apply(context, arguments);
                }
            };
        },

        /**
         * ### Toolbar.prototype.toggleActions
         * ...
         */
        toggleActions: function (actions, disable) {
            var self = this;

            if (typeof actions === "string") {
                actions = actions.split(" ");
            }

            $.map(actions, function (action) {
                var $tool = self.$element.find("[data-action=" + action + "]");

                $tool.toggleClass("disabled", disable);
            });
        },

        /**
         * ### Toolbar.prototype.enable
         * ...
         */
        enable: function (actions) {
            this.toggleActions(actions, false);
        },

        /**
         * ### Toolbar.prototype.disable
         * ...
         */
        disable: function (actions) {
            this.toggleActions(actions, true);
        }
    };

    return Toolbar;

});
/**
 * # module/palette
 *
 * ...
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('module/palette',[
    "jquery",
    "util/util",
    "module/toolbar"
],
function ($, util, Toolbar) {

    "use strict";

    var defaults = {
        name: "",
        visible: false,
        actions: {},
        fields: {}
    };

    /**
     * ## Palette
     *
     * Create a new `Palette` instance
     *
     * @constructor
     * @param {element} element
     * @param {object} options
     */
    var Palette = function (element, options) {
        this.$element = $(element);
        this.settings = $.extend({}, defaults, options);
        this.name = this.settings.name;
        this.visible = this.settings.visible;
        this.actions = this.settings.actions;
        this.fields = this.settings.fields;
        this.source = null;

        this.init();
    };

    Palette.classname = ".stitches-palette";

    util.inherit(Palette, Toolbar, {
        /**
         * ### Palette.prototype.init
         * ...
         */
        init: function () {
            this._super("init", this, arguments);

            this.$element.toggleClass("in", this.visible);
        },

        /**
         * ### Palette.prototype.bind
         * ...
         */
        bind: function () {
            var self = this;

            this._super("bind", this, arguments);

            $.each(this.fields, function (field, events) {
                $.each(events, function (event, callback) {
                    var selector = "[name=" + field + "]";
                    var handler = self.getHandler(self, callback);

                    self.$element.on(event, selector, handler);
                });
            });
        },

        /**
         * ### Palette.prototype.open
         * ...
         */
        open: function () {
            this.$element.addClass("in");
            this.visible = true;
        },

        /**
         * ### Palette.prototype.close
         * ...
         */
        close: function () {
            this.$element.removeClass("in");
            this.visible = false;
        },

        /**
         * ### Palette.prototype.configure
         * ...
         */
        configure: function (properties) {
            var self = this;

            this.source = properties.source;

            $.each(properties.inputs, function (name, value) {
                var selector = "input[name=" + name + "]";
                var $input = self.$element.find(selector);
                var type = $input.attr("type");

                switch (type) {
                case "radio":
                case "checkbox":
                    $input = $input.removeAttr("checked").filter("[value=" + value + "]");
                    $input.attr("checked", "checked");
                    break;
                default:
                    $input.val(value);
                    break;
                }
            });
        }
    });

    return Palette;

});
/**
 * # module/stitches
 *
 * ...
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 */
/*global require, define */

define('module/stitches',[
    "jquery",
    "modernizr",
    "../../../lib/store/store",
    "util/util",
    "util/layout",
    "util/templates",
    "module/file-manager",
    "module/drop-box",
    "module/canvas",
    "module/toolbar",
    "module/palette"
],
function($, Modernizr, store, util, layout, templates, FileManager, DropBox, Canvas, Toolbar, Palette) {

    "use strict";

    (function () {
        if (typeof FileReader === "undefined" || !Modernizr.draganddrop) {
            require(["../../../lib/dropfile/dropfile"]);
        }

        if (!Modernizr.canvas) {
            require(["../../../lib/flashcanvas/flashcanvas"]);
        }
    }());

    var defaults = {
        layout: "compact",
        prefix: "sprite",
        padding: 5,
        uri: false,
        style: "css"
    };

    /**
     * ## Stitches
     *
     * Create a new `Stitches` instance
     *
     * @constructor
     * @param {element} element
     * @param {object} options
     */
    var Stitches = function (element, options) {
        this.$element = $(element);
        this.settings = $.extend({}, defaults, options);

        this.init();
    };

    Stitches.prototype = {
        constructor: Stitches,

        /**
         * ### Stitches.prototype.init
         * ...
         */
        init: function () {
            this.configure();
            this.render();
            this.bind();

            this.setFileManager();
            this.setDropBox();
            this.setToolbar();
            this.setLayout();
            this.setImages();
            this.setCanvas();
            this.setPalettes();
        },

        /**
         * ### Stitches.prototype.configure
         * ...
         */
        configure: function () {
            var settings;

            if (store && !store.disabled) {
                settings = store.get("stitches-settings");
            }

            if (settings) {
                this.settings = $.extend(this.settings, settings);
            }
        },

        /**
         * ### Stitches.prototype.render
         * ...
         */
        render: function () {
            var html = templates.stitches({});

            this.$element.append(html);
            this.$overlay = this.$element.find(".stitches-overlay");
            this.$dropBox = this.$element.find(".stitches-drop-box");
            this.$toolbar = this.$element.find(".stitches-toolbar");
            this.$canvas = this.$element.find(".stitches-canvas");
            this.$progress = this.$element.find(".stitches-progress .progress");
            this.$progressBar = this.$element.find(".stitches-progress .bar");
            this.$about = this.$element.find(".stitches-about");
            this.$settings = this.$element.find(".stitches-settings");
            this.$properties = this.$element.find(".stitches-properties");
        },

        /**
         * ### Stitches.prototype.bind
         * ...
         */
        bind: function () {
            this.$element.on("show-overlay", $.proxy(this.showOverlay, this));
            this.$element.on("hide-overlay", $.proxy(this.hideOverlay, this));
            this.$element.on("open-about", $.proxy(this.openAbout, this));
            this.$element.on("close-about", $.proxy(this.closeAbout, this));
            this.$element.on("open-settings", $.proxy(this.openSettings, this));
            this.$element.on("close-settings", $.proxy(this.closeSettings, this));
            this.$element.on("open-properties", $.proxy(this.openProperties, this));
            this.$element.on("close-properties", $.proxy(this.closeProperties, this));
            this.$element.on("close-palettes", $.proxy(this.closePalettes, this));
            this.$element.on("process-files", $.proxy(this.processFiles, this));
            this.$element.on("update-toolbar", $.proxy(this.updateToolbar, this));
            this.$element.on("generate-sheets", $.proxy(this.generateSheets, this));
            this.$element.on("error", $.proxy(this.errorHandler, this));
        },

        /**
         * ### Stitches.prototype.setFileManager
         * ...
         */
        setFileManager: function () {
            this.fileManager = new FileManager(this.$canvas, {
                progress: $.proxy(this.updateProgress, this)
            });
        },

        /**
         * ### Stitches.prototype.setDropBox
         * ...
         */
        setDropBox: function () {
            this.dropBox = new DropBox(this.$dropBox);
        },

        /**
         * ### Stitches.prototype.setLayout
         * ...
         */
        setLayout: function () {
            layout.setLayout(this.settings.layout);
        },

        /**
         * ### Stitches.prototype.setImages
         * ...
         */
        setImages: function () {
            this.images = this.$element.find("> img").get();
        },

        /**
         * ### Stitches.prototype.setCanvas
         * ...
         */
        setCanvas: function () {
            this.canvas = new Canvas(this.$canvas, {
                images: this.images,
                padding: this.settings.padding,
                progress: $.proxy(this.updateProgress, this)
            });
        },

        /**
         * ### Stitches.prototype.setToolbar
         * ...
         */
        setToolbar: function () {
            var self = this;

            this.toolbar = new Toolbar(this.$toolbar, {
                name: "toolbar",
                actions: {
                    open: {
                        change: function (e) {
                            var $input = self.$toolbar.find("input[type=file]");
                            var $clone = $input.clone(true).val("");
                            var files = e.target.files;

                            self.$element.trigger("process-files", [files]);
                            $input.replaceWith($clone);
                        }
                    },
                    settings: {
                        click: function (e) {
                            self.$element.trigger("open-settings");
                        }
                    },
                    reset: {
                        click: function (e) {
                            self.canvas.reset();
                        }
                    },
                    generate: {
                        click: function (e) {
                            self.$element.trigger("show-overlay");
                            self.$element.trigger("generate-sheets");
                            self.$element.trigger("hide-overlay");
                        }
                    },
                    clear: {
                        click: function (e) {
                            self.canvas.clear();
                        }
                    },
                    spritesheet: {
                        click: function (e) {}
                    },
                    stylesheet: {
                        click: function (e) {}
                    },
                    about: {
                        click: function (e) {
                            self.$element.trigger("open-about");
                        }
                    }
                }
            });
        },

        /**
         * ### Stitches.prototype.setPalettes
         * ...
         */
        setPalettes: function () {
            var self = this;

            var about = new Palette(this.$about, {
                name: "about",
                visible: true,
                actions: {
                    close: {
                        click: function (e) {
                            this.close();
                        }
                    }
                }
            });

            var settings = new Palette(this.$settings, {
                name: "settings",
                visible: false,
                actions: {
                    close: {
                        click: function (e) {
                            self.$element.trigger("close-settings");
                        }
                    }
                },
                fields: {
                    layout: {
                        "change": function (e) {
                            var $checked = this.$element.find("input[name=layout]:checked");
                            var value = $checked.val();

                            this.source.layout = value;
                            layout.setLayout(value);

                            self.update();
                        }
                    },
                    style: {
                        "change": function (e) {
                            var $checked = this.$element.find("input[name=style]:checked");
                            var value = $checked.val();

                            self.settings.style = value;

                            self.update();
                        }
                    },
                    prefix: {
                        "input blur": function (e) {
                            var value = $(e.currentTarget).val();

                            this.source.prefix = value;

                            self.update();
                        }
                    },
                    padding: {
                        "input blur": function (e) {
                            var value = $(e.currentTarget).val();

                            this.source.padding = value;
                            self.canvas.padding = value;

                            $.map(self.canvas.sprites, function (sprite) {
                                sprite.configure({
                                    padding: value
                                });
                            });

                            self.update();
                        }
                    },
                    uri: {
                        "change": function (e) {
                            var value = $(e.currentTarget).is(":checked");

                            this.source.uri = value;

                            self.update();
                        }
                    }
                }
            });

            var properties = new Palette(this.$properties, {
                name: "properties",
                visible: false,
                actions: {
                    close: {
                        click: function (e) {
                            self.$element.trigger("close-properties");
                        }
                    },
                    remove: {
                        click: function (e) {
                            var sprite = this.source;

                            self.canvas.remove(sprite);
                        }
                    }
                },
                fields: {
                    name: {
                        "input blur": function (e) {
                            var sprite = this.source;
                            var name = $(e.currentTarget).val();
                            var clean = sprite.cleanName(name);

                            this.source.name = clean;

                            if (name !== clean) {
                                $(e.currentTarget).val(clean);
                            }
                        }
                    }
                }
            });

            this.palettes = {
                about: about,
                settings: settings,
                properties: properties
            };
        },

        /**
         * ### Stitches.prototype.update
         * ...
         */
        update: function () {
            this.canvas.reset();

            if (store && !store.disabled) {
                store.set("stitches-settings", this.settings);
            }
        },

        /**
         * ### Stitches.prototype.showOverlay
         * ...
         */
        showOverlay: function (e, type) {
            this.$overlay.fadeTo("fast", 0.4);
        },

        /**
         * ### Stitches.prototype.hideOverlay
         * ...
         */
        hideOverlay: function (e) {
            this.$overlay.fadeOut("fast");
        },

        /**
         * ### Stitches.prototype.openAbout
         * ...
         */
        openAbout: function (e) {
            this.closePalettes();

            this.palettes.about.open();
        },

        /**
         * ### Stitches.prototype.closeAbout
         * ...
         */
        closeAbout: function (e) {
            if (this.palettes.about.visible) {
                this.palettes.about.close();
            }
        },

        /**
         * ### Stitches.prototype.openSettings
         * ...
         */
        openSettings: function (e) {
            this.closePalettes();

            this.palettes.settings.configure({
                source: this.settings,
                inputs: {
                    layout: this.settings.layout,
                    style: this.settings.style,
                    prefix: this.settings.prefix,
                    padding: this.settings.padding,
                    uri: this.settings.uri
                }
            });

            this.palettes.settings.open();
        },

        /**
         * ### Stitches.prototype.closeSettings
         * ...
         */
        closeSettings: function (e) {
            if (this.palettes.settings.visible) {
                this.palettes.settings.close();
            }
        },

        /**
         * ### Stitches.prototype.openProperties
         * ...
         */
        openProperties: function (e, sprite) {
            this.closePalettes();

            this.palettes.properties.configure({
                source: sprite,
                inputs: {
                    name: sprite.name,
                    x: sprite.left(),
                    y: sprite.top()
                }
            });

            this.palettes.properties.open();
        },

        /**
         * ### Stitches.prototype.closeProperties
         * ...
         */
        closeProperties: function (e) {
            if (this.palettes.properties.visible) {
                this.palettes.properties.close();
                this.canvas.$element.trigger("clear-active", [true]);
            }
        },

        /**
         * ### Stitches.prototype.closePalettes
         * ...
         */
        closePalettes: function (e) {
            this.closeAbout();
            this.closeSettings();
            this.closeProperties();
        },

        /**
         * ### Stitches.prototype.processFiles
         * ...
         */
        processFiles: function (e, files) {
            this.fileManager.processFiles(files);
        },

        /**
         * ### Stitches.prototype.updateToolbar
         * ...
         */
        updateToolbar: function (e) {
            var $toolbar = this.toolbar.$element;
            var toolbar = this.toolbar;
            var canvas = this.canvas;

            if (canvas.sprites.length) {
                toolbar.enable("reset generate clear spritesheet stylesheet");
                $toolbar.find("[data-action=spritesheet]").attr("href", this.spritesheet);
                $toolbar.find("[data-action=stylesheet]").attr("href", this.stylesheet);
            } else {
                toolbar.disable("reset generate clear spritesheet stylesheet");
                $toolbar.find("[data-action=spritesheet]").attr("href", "#");
                $toolbar.find("[data-action=stylesheet]").attr("href", "#");
            }
        },

        /**
         * ### Stitches.prototype.updateProgress
         * ...
         */
        updateProgress: function (progress, type) {
            var percent = Math.ceil(progress * 100);

            if (percent === 100 && type !== "danger" && type !== "warning") {
                type = "success";
            }

            if (type) {
                this.$progress.attr({
                    "class": "progress progress-striped progress-" + type
                });
            }

            this.$progressBar.css({
                width: percent + "%"
            });
        },

        /**
         * ### Stitches.prototype.generateSheets
         * ...
         */
        generateSheets: function (e) {
            var sprites = this.canvas.sprites;
            var dimensions = this.canvas.dimensions;
            var prefix = this.settings.prefix;
            var uri = this.settings.uri;
            var style = this.settings.style;
            var spritesheet;
            var stylesheet;

            spritesheet = layout.makeSpritesheet(sprites, dimensions);
            stylesheet = layout.makeStylesheet(sprites, spritesheet, prefix, uri, style);

            try {
                spritesheet = util.dataToObjectURL(spritesheet);
                stylesheet = util.dataToObjectURL(stylesheet);
            } catch (ex) {
                this.$element.trigger("error", [ex]);
            }

            this.spritesheet = spritesheet;
            this.stylesheet = stylesheet;

            this.$element.trigger("update-toolbar");
            this.updateProgress(1, "success");
        },

        /**
         * ### Stitches.prototype.errorHandler
         * ...
         */
        errorHandler: function (e, err, type) {
            this.updateProgress(1, type || "warning");
        }
    };

    return Stitches;

});
/**
 * # Stitches
 * ### _An HTML5 Sprite Sheet Generator_
 *
 * > http://draeton.github.com/stitches<br/>
 * > Copyright 2013, Matthew Cobbs<br/>
 * > Licensed under the MIT license.
 *
 * Stitches is an HTML5 sprite sheet generator.
 *
 * Stitches is developed by Matthew Cobbs in concert with the lovely open-source
 * community at Github. Thanks are owed to the developers at Twitter for
 * [Bootstrap](http://twitter.github.com/bootstrap), and
 * [Glyphicons](http://glyphicons.com/) for some cool little icons.
 *
 * Addtionally, I want to thank [James Taylor](https://github.com/jbt)
 * for the [Docker](https://github.com/jbt/docker) documentation tool, and
 * [Phil Mander](https://github.com/philmander) for his JSHint and JSTestRunner
 * Ant tasks, which round out my build toolchain, and most of all the good folks
 * who develop [RequireJS](http://requirejs.org/) for helping this all make
 * sense.
 */
/*global requirejs, require, define */

/**
 * ### RequireJS Main
 *
 * Kicks off application on elements matching `.stitches`
 */
require({
    paths: {
        "tpl" : "../tpl",
        "jquery": "wrap/jquery",
        "modernizr": "wrap/modernizr"
    }
},
[
    "jquery",
    "module/stitches"
],
function($, Stitches) {

    "use strict";

    $(document).ready(function () {

        var selector = ".stitches";

        $(selector).each(function () {
            var stitches = new Stitches(this);
        });
    });

});
define("stitches", function(){});
