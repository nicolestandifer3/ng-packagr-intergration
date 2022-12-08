import type { CompilerHost, CompilerOptions } from '@angular/compiler-cli';
import convertSourceMap from 'convert-source-map';

import { createHash } from 'crypto';
import * as path from 'path';
import ts from 'typescript';
import { NgPackageConfig } from '../../ng-package.schema';
import { FileCache } from '../file-system/file-cache';
import { BuildGraph } from '../graph/build-graph';
import { Node } from '../graph/node';
import { EntryPointNode, fileUrl } from '../ng-package/nodes';
import { StylesheetProcessor } from '../styles/stylesheet-processor';
import { ensureUnixPath } from '../utils/path';

export function cacheCompilerHost(
  graph: BuildGraph,
  entryPoint: EntryPointNode,
  compilerOptions: CompilerOptions,
  moduleResolutionCache: ts.ModuleResolutionCache,
  stylesheetProcessor?: StylesheetProcessor,
  inlineStyleLanguage?: NgPackageConfig['inlineStyleLanguage'],
  sourcesFileCache: FileCache = entryPoint.cache.sourcesFileCache,
): CompilerHost {
  const compilerHost = ts.createIncrementalCompilerHost(compilerOptions);

  const getNode = (fileName: string) => {
    const nodeUri = fileUrl(ensureUnixPath(fileName));
    let node = graph.get(nodeUri);

    if (!node) {
      node = new Node(nodeUri);
      graph.put(node);
    }

    return node;
  };

  const addDependee = (fileName: string) => {
    const node = getNode(fileName);
    entryPoint.dependsOn(node);
  };

  const { flatModuleFile, destinationPath, entryFile } = entryPoint.data.entryPoint;
  const flatModuleFileDtsFilename = `${flatModuleFile}.d.ts`;
  const flatModuleFileDtsPath = ensureUnixPath(path.join(destinationPath, flatModuleFileDtsFilename));
  const hasIndexEntryFile = path.basename(entryFile.toLowerCase()) === 'index.ts';

  return {
    ...compilerHost,

    // ts specific
    fileExists: (fileName: string) => {
      const cache = sourcesFileCache.getOrCreate(fileName);
      if (cache.exists === undefined) {
        cache.exists = compilerHost.fileExists.call(this, fileName);
      }

      return cache.exists;
    },

    getSourceFile: (fileName: string, languageVersion: ts.ScriptTarget) => {
      addDependee(fileName);
      const cache = sourcesFileCache.getOrCreate(fileName);
      if (!cache.sourceFile) {
        cache.sourceFile = compilerHost.getSourceFile.call(this, fileName, languageVersion);
      }

      return cache.sourceFile;
    },

    writeFile: (
      fileName: string,
      data: string,
      writeByteOrderMark: boolean,
      onError?: (message: string) => void,
      sourceFiles?: ReadonlyArray<ts.SourceFile>,
    ) => {
      if (fileName.endsWith('.d.ts')) {
        if (fileName === flatModuleFileDtsPath) {
          if (hasIndexEntryFile) {
            // In case the entry file is index.ts, we should not emit the `d.ts` which are a re-export of the `index.ts`.
            // Because it will cause a conflict.
            return;
          } else {
            // Rename file to index.d.ts so that TypeScript can resolve types without
            // them needing to be referenced in the package.json manifest.
            fileName = fileName.replace(flatModuleFileDtsFilename, 'index.d.ts');
          }
        }

        sourceFiles.forEach(source => {
          const cache = sourcesFileCache.getOrCreate(source.fileName);
          if (!cache.declarationFileName) {
            cache.declarationFileName = ensureUnixPath(fileName);
          }
        });
      } else {
        fileName = fileName.replace(/\.js(\.map)?$/, '.mjs$1');
        const outputCache = entryPoint.cache.outputCache;

        // Extract inline sourcemap which will later be used by rolluo.
        const version = createHash('sha256').update(data).digest('hex');
        let map = undefined;
        if (fileName.endsWith('.mjs')) {
          const cachedData = outputCache.get(fileName);
          map = cachedData?.version === version ? cachedData.map : convertSourceMap.fromComment(data).toJSON();
        }

        outputCache.set(fileName, {
          content: data,
          version,
          map,
        });
      }

      compilerHost.writeFile.call(this, fileName, data, writeByteOrderMark, onError, sourceFiles);
    },

    readFile: (fileName: string) => {
      addDependee(fileName);
      const cache = sourcesFileCache.getOrCreate(fileName);
      if (cache.content === undefined) {
        cache.content = compilerHost.readFile.call(this, fileName);
      }

      return cache.content;
    },

    resolveModuleNames: (moduleNames: string[], containingFile: string) => {
      return moduleNames.map(moduleName => {
        const { resolvedModule } = ts.resolveModuleName(
          moduleName,
          ensureUnixPath(containingFile),
          compilerOptions,
          compilerHost,
          moduleResolutionCache,
        );

        return resolvedModule;
      });
    },

    resourceNameToFileName: (resourceName: string, containingFilePath: string) => {
      const resourcePath = path.resolve(path.dirname(containingFilePath), resourceName);
      const containingNode = getNode(containingFilePath);
      const resourceNode = getNode(resourcePath);
      containingNode.dependsOn(resourceNode);

      return resourcePath;
    },

    readResource: async (fileName: string) => {
      addDependee(fileName);

      const cache = sourcesFileCache.getOrCreate(fileName);
      if (cache.content === undefined) {
        if (!compilerHost.fileExists(fileName)) {
          throw new Error(`Cannot read file ${fileName}.`);
        }

        if (/(?:html?|svg)$/.test(path.extname(fileName))) {
          // template
          cache.content = compilerHost.readFile.call(this, fileName);
        } else {
          // stylesheet
          cache.content = await stylesheetProcessor.process({
            filePath: fileName,
            content: compilerHost.readFile.call(this, fileName),
          });
        }

        cache.exists = true;
      }

      return cache.content;
    },
    transformResource: async (data, context) => {
      if (context.resourceFile || context.type !== 'style') {
        return null;
      }

      if (inlineStyleLanguage) {
        const key = createHash('sha1').update(data).digest('hex');
        const fileName = `${context.containingFile}-${key}.${inlineStyleLanguage}`;
        const cache = sourcesFileCache.getOrCreate(fileName);
        if (cache.content === undefined) {
          cache.content = await stylesheetProcessor.process({
            filePath: fileName,
            content: data,
          });

          const virtualFileNode = getNode(fileName);
          const containingFileNode = getNode(context.containingFile);
          virtualFileNode.dependsOn(containingFileNode);
        }

        cache.exists = true;

        return { content: cache.content };
      }

      return null;
    },
  };
}

export function augmentProgramWithVersioning(program: ts.Program): void {
  const baseGetSourceFiles = program.getSourceFiles;
  program.getSourceFiles = function (...parameters) {
    const files: readonly (ts.SourceFile & { version?: string })[] = baseGetSourceFiles(...parameters);

    for (const file of files) {
      if (file.version === undefined) {
        file.version = createHash('sha256').update(file.text).digest('hex');
      }
    }

    return files;
  };
}
