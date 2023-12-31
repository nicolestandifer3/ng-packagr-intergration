# Design Doc: "ng-packagr"

> Packaging TypeScript libraries in Angular Package Format

## Library authoring

Design choices of `ng-packagr` from the view of library authors and library consumers.

The motivation is to help authors write libraries and generate the expected, distribution-ready artefacts for library consumers.

### Build artefacts

According to [Angular Package Format](https://docs.google.com/document/d/1CZC2rcpxffTDfRDs6p1cfbmKNLA6x5O-NtkJglDaBVs/preview), there need to be the following build artefacts:

* FESM2015 Bundle: `@<prefix>/<name>.js` in ES2015 syntax and ES2015 module format, a so-called Flat ECMAScript Module. It is referenced in the `es2015` property of `package.json`.
* Type definitions: an `index.d.ts` file is needed to support TypeScript debugging and rich developer experience. It is references in the `typings` property of `package.json`
* A `package.json` file: it describes the structure of the library and serves as the entry point for library users, when resolving TypeScript import statements: `import { .. } from '@<prefix>/<name>'`.
* A `README.md` and `LICENSE` file for the library. These files should be located next to the `package.json` (and can be copied "as is" / static assets).

**DO**: `ng-packagr` generates a TypeScript library in Angular Package Format.
JavaScript bundles, type definitions and AoT metadata are auto-generated during build.

### Public API entry

Angular core libraries make heavy use of this pattern.
They provide a `public_api.ts` file as entry point to their library.
The file and all sources referenced from with this file are transpiled and bundled up in the library's public-facing API.
This pattern is also a recommended approach for building flat modules.

**DO**: `ng-packagr` supports a single entry file to a library's public API.

### Package definition and library metadata

For consumers of a library, the package definition is provided in a `package.json` file, including `peerDependencies`, `name`, `version`, etc.
Most important, the build artefacts (see above) are referenced in `package.json`.
In this way, library consumers and build tools will pick-up the correct build artefact of the library for compiling their applications.

**DO**: `ng-packagr` generates a `package.json` for library consumers.
To do so, it needs an input `package.json` that includes basic information like `name` and `version` and it will add references to the auto-generated build artefacts.

A `package.json` also includes information needed to distribute and publish the library.
Typical steps in a publishing workflow are: verify or control version number (version bumping), generate a changelog, keep track of public API changes, tagging a release, publishing to a registry.
A lot of tools exist for this kind of purposes.
For example, [standard-version](https://github.com/conventional-changelog/standard-version) generates changelogs, manages semantic version numbers, and tags releases.
If necessary, it's recommended that these tools pick up the `package.json` generated by `ng-packagr` and modify it (e.g. increase version number).

**DON'T**: `ng-packagr` **WILL NOT** implement a publishing workflow.

### Folder layout

Various folder layouts exist and are commonly used within the Angular community.
The different styles are reflected in the [integration samples of ng-packagr](../integration).

First, the Angular core package layout:

```
|- package.json
|- public_api.ts
|- src
   |- module.ts
   |- foo
      |- foo.ts
   |- bar
      |- bar.ts
```

Then, the material design layout:

```
|- package.json
|- public_api.ts
|- module.ts
|- ..
|- foo
   |- foo.ts
|- bar
   |- bar.ts
```

Finally, a custom folder layout:

```
|- package.json
|- src
   |- public_api.ts
   |- module.ts
   |- ..
   |- foo
      |- foo.ts
   |- bar
      |- bar.ts
```

**DO**: `ng-packagr` supports different folder layouts by setting paths in a JSON configuration file (see below).
The one restriction is that the `package.json` file locates the source folder of a library.

### Configuration and customization

Tools in the Angular ecosystem commonly support configuration through a JSON file.
Typically, people in the Angular community should be somewhat familiar with `tsconfig.json`, `package.json`, `.angular-cli.json`, and others.
These JSON files can be separated into two categories:
a JSON configuration file per project (e.g. `tsconfig.json`) or a JSON configuration file per utility tool (possibly, with multiple projects configured inside, e.g. `.angular-cli.json`)
Other tools support configuration by scripting `*.js` files like `karma.conf.js`, `webpack.conf.js`, or `rollup-config.js`.
Whether configuration is supported through a declarative JSON file or through a programmatic JS file is a deliberate design choice.

**DO**: `ng-packagr` supports one JSON configuration file per project.
By default, the name `ng-package.json` in the current working directory is assumed.
A custom file name can be passed as a CLI argument.
Further paths are resolved relative to `ng-package.json`.
To help writing the JSON file, a JSON schema ships with `ng-packagr`.

From that deliberate design choice, the following considerations are derived. `ng-package.json`…

* …IS a declarative way of describing an Angular library.
  * Multiple libraries are handled by writing one `ng-package.json` file per project and running `ng-packagr` for each project.
* …SHOULD describe the properties and characteristics of an Angular library . Library authors should take care of describing _WHAT_ their library looks like.
* …SHOULD NOT try to pass-up configuration of internal tools (e.g. `tsc` or `rollup` configs). This would put burden on library authors to take care of _HOW_ an internal build process is orchestrated.

---

## Tools and implementation details

Internally, `ng-packagr` is going to use several other tools to do the desired transformations from TypeScript sources (+ HTML templates and stylesheets) to Angular package format.
Here is a trade-off decision:

As first option, `ng-packagr` allows users to provide a full custom configuration for tools such as `ngc`, `rollup`, and so on.
This forces users to write a configuration file for these tools and deal with configuration options.

Alternatively, `ng-packagr` will hide configuration and internals of tools such as `ngc`, `rollup`, and so on.
In this case, the configuration of `ng-packagr` will only allow to configure a limited set of options that will be passed through to the tools.

#### NGC: tsconfig.json

Right now, `@angular/tsc-wrapped` does not support the `"extends"` property of `tsconfig.json`.
Because of that, `ng-packagr` needs to support self-contained JSON configuration files for ngc.
If auto-generating a tsconfig, `ng-packagr` would need to read its default values, merge that with the custom user tsconfig and copy the result to its working directory.

The most important setting here is the `"files": []` property, which must contain exactly one file since `"flatModuleId"` and `"flatModuleOutFile"` options will also be used for flattened library indexes.
The value for `"flatModuleId"` could be inferred by the library's name as given in `package.json`, `"flatModuleOutFile"` could be statically set to `"index"`.

Other configuration properties like `"target"` or `"module"` cannot be set by users since the order of transformations relies on certain settings.
For example, `ngc` will need to compile to `"target": "es2015"` and `"module": "es2015"` in order to allow subsequent steps to happen.

~The path to `tsconfig.json` will be given `ngc.tsconfig` JSON configuration property.~
~A default configuration file should be provided with the tool, so that users can copy&paste.~

#### Rollup Config

For generating the bundled versions of the library, rollup will be used.
Rollup requires a configuration with a symbol mapping table.

Reasonable default values should be shipped with `ng-packagr` without forcing users to write special configuration.
The default configuration should try to support `@angular/*` packages as well as `rxjs`, which is a transitive dependency in most cases and also requires special configuration in Rollup.

Other configuration properties like `"entry"` or `"format"` cannot be set by users since their values depend on the order of transformations being applied.
For example, the transformation to UMD requires an FESM2015 input file.
The FESM2015 input file got created prior in the build process, thus `ng-packagr` will pass both the `"entry"` and `"format"` property to `rollup` without users being able to customize.

~If required, users should be able to provide a custom rollup configuration to `ng-packagr` by settings the `rollup.config` JSON configuration property.~

---
