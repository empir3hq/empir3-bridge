'use strict';

const { readdir, readFile, stat } = require('node:fs/promises');
const { join } = require('node:path');

const DEFAULT_BATCH_SIZE = 64;

function localFileSignature(file) {
  return `${Number(file?.size || 0)}:${Math.round(Number(file?.mtimeMs || 0))}`;
}

async function readProjectMeta(projectDir, metaFileName) {
  try {
    return JSON.parse(await readFile(join(projectDir, metaFileName), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build the local project-mirror manifest without monopolizing the Bridge event
 * loop. Directory reads and file stats stay asynchronous, with a bounded batch
 * size so large workspaces remain responsive without issuing unbounded I/O.
 */
async function buildProjectManifest({
  root,
  metaFileName,
  shouldIgnorePath,
  maxFileBytes,
  onSkip = () => {},
  onError = () => {},
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  if (!root || !metaFileName || typeof shouldIgnorePath !== 'function') {
    throw new Error('root, metaFileName, and shouldIgnorePath are required');
  }
  const boundedBatchSize = Number.isInteger(batchSize) && batchSize > 0
    ? Math.min(batchSize, 256)
    : DEFAULT_BATCH_SIZE;
  const manifest = {};

  let projectFolders;
  try {
    projectFolders = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') onError({ path: root, error });
    return manifest;
  }

  for (const folderEntry of projectFolders) {
    // Junctions and symlinks are intentionally not followed: a project mirror
    // must never escape its approved root or recurse through a link cycle.
    if (!folderEntry.isDirectory()) continue;
    const folder = folderEntry.name;
    const projectDir = join(root, folder);
    const meta = await readProjectMeta(projectDir, metaFileName);
    if (!meta?.projectId) continue;

    const files = [];
    const pendingDirectories = [{ directory: projectDir, prefix: '' }];
    while (pendingDirectories.length > 0) {
      const current = pendingDirectories.pop();
      let entries;
      try {
        entries = await readdir(current.directory, { withFileTypes: true });
      } catch (error) {
        onError({ path: current.directory, error });
        continue;
      }

      for (let offset = 0; offset < entries.length; offset += boundedBatchSize) {
        const batch = entries.slice(offset, offset + boundedBatchSize);
        const discovered = await Promise.all(batch.map(async (entry) => {
          const relativePath = current.prefix
            ? `${current.prefix}/${entry.name}`
            : entry.name;
          if (shouldIgnorePath(relativePath)) return null;
          const fullPath = join(current.directory, entry.name);
          if (entry.isDirectory()) {
            return { kind: 'directory', directory: fullPath, prefix: relativePath };
          }
          if (!entry.isFile()) return null;
          try {
            const fileStat = await stat(fullPath);
            if (!fileStat.isFile()) return null;
            if (fileStat.size > maxFileBytes) {
              onSkip({ path: relativePath, size: fileStat.size, maxFileBytes });
              return null;
            }
            return {
              kind: 'file',
              file: {
                path: relativePath,
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs,
                hash: '',
              },
            };
          } catch (error) {
            onError({ path: fullPath, error });
            return null;
          }
        }));

        for (const item of discovered) {
          if (!item) continue;
          if (item.kind === 'directory') pendingDirectories.push(item);
          else files.push(item.file);
        }
      }
    }

    const project = {
      projectId: meta.projectId,
      projectName: meta.projectName || folder,
      files,
    };
    manifest[folder] = project;
    manifest[meta.projectId] = project;
  }

  return manifest;
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  buildProjectManifest,
  localFileSignature,
};
