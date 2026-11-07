import { useEffect, useState } from 'react';

import { listFiles, type FileTreeNode } from '../../lib/api.js';

/** The properties of the file tree. */
export interface FileTreeProps {
  /** The project the tree belongs to. */
  projectId: string;
  /** The path of the file that is currently open. */
  activePath: string | undefined;
  /** Called when a file is chosen. */
  onSelect(path: string): void;
}

/**
 * The project's file tree.
 *
 * The tree is fetched when the project changes. A file that is chosen becomes
 * the active one, which the editor marks.
 */
export function FileTree({ projectId, activePath, onSelect }: FileTreeProps): React.ReactElement {
  const [nodes, setNodes] = useState<FileTreeNode[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setError(undefined);

    void listFiles(projectId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setNodes(result.tree);
        // Every directory starts open, so the tree is usable at once.
        setExpanded(new Set(collectDirectories(result.tree)));
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setError(cause instanceof Error ? cause.message : 'Could not load the files.');
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const toggle = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <nav className="p-2" aria-label="Project files">
      {error ? (
        <p role="alert" className="p-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <ul className="space-y-0.5">
        {nodes.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            expanded={expanded}
            onToggle={toggle}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </nav>
  );
}

/** One entry of the tree, with its children. */
interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
  activePath: string | undefined;
  expanded: Set<string>;
  onToggle(path: string): void;
  onSelect(path: string): void;
}

/** Render one node and, for a directory, its children. */
function TreeNode({
  node,
  depth,
  activePath,
  expanded,
  onToggle,
  onSelect,
}: TreeNodeProps): React.ReactElement {
  const isDirectory = node.type === 'directory';
  const isOpen = expanded.has(node.path);
  const isActive = activePath === node.path;
  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  if (isDirectory) {
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          aria-expanded={isOpen}
          style={indent}
          className="flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-sm text-slate-700 hover:bg-slate-100"
        >
          <span aria-hidden="true" className="w-3 text-xs text-slate-400">
            {isOpen ? '▾' : '▸'}
          </span>
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && node.children ? (
          <ul className="space-y-0.5">
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        style={indent}
        aria-current={isActive ? 'true' : undefined}
        className={`block w-full truncate rounded py-1 pr-2 text-left text-sm hover:bg-slate-100 ${
          isActive ? 'bg-slate-200 font-medium text-slate-900' : 'text-slate-700'
        }`}
      >
        {node.name}
      </button>
    </li>
  );
}

/** The paths of every directory in a tree. */
export function collectDirectories(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === 'directory') {
      paths.push(node.path);
      if (node.children) {
        paths.push(...collectDirectories(node.children));
      }
    }
  }
  return paths;
}
