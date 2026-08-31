'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { MindMapTree } from '@/lib/types/mindmap';
import { treeToOutlineDoc, type OutlineItem } from '@/lib/utils/outline';

interface OutlineViewProps {
  tree: MindMapTree;
  selectedNodeId: string | null;
  /** 实时生成回放中：行内编辑与增删入口锁定，浏览/选中/展开收起保留 */
  generating?: boolean;
  onSelectNode: (id: string) => void;
  onUpdateNodeContent: (id: string, content: string) => void;
  onAddChild: (parentId: string) => string | void;
  onAddSibling: (nodeId: string) => string | void;
}

/** 大纲渲染用嵌套结构 */
interface OutlineRenderNode {
  item: OutlineItem;
  children: OutlineRenderNode[];
}

function buildRenderTree(items: OutlineItem[]): OutlineRenderNode[] {
  const roots: OutlineRenderNode[] = [];
  const stack: Array<{ depth: number; node: OutlineRenderNode }> = [];

  for (const item of items) {
    const renderNode: OutlineRenderNode = { item, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].depth >= item.depth) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(renderNode);
    } else {
      stack[stack.length - 1].node.children.push(renderNode);
    }
    stack.push({ depth: item.depth, node: renderNode });
  }

  return roots;
}

export function OutlineView({
  tree,
  selectedNodeId,
  generating = false,
  onSelectNode,
  onUpdateNodeContent,
  onAddChild,
  onAddSibling,
}: OutlineViewProps) {
  const doc = useMemo(() => treeToOutlineDoc(tree), [tree]);
  const nested = useMemo(() => buildRenderTree(doc.items), [doc]);

  // 当前行内编辑中的节点（'root' 表示文档标题）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // 已收起的节点 id 集合：以 nodeId 为键，编辑/重渲染不改变 id，
  // 因此数据更新或组件重渲染时展开/收起状态保持一致；新节点默认展开
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());

  const inputRef = useRef<HTMLInputElement>(null);

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const beginEdit = useCallback(
    (nodeId: string, currentContent: string) => {
      if (generating) return; // 生成中禁止进入行内编辑
      setEditingId(nodeId);
      setDraft(currentContent);
    },
    [generating],
  );

  const commit = useCallback(
    (nodeId: string) => {
      if (nodeId === 'root') {
        const next = draft.trim();
        if (!generating && next && next !== doc.rootContent) {
          onUpdateNodeContent(doc.rootId, next);
        }
      } else {
        const item = doc.items.find((entry) => entry.nodeId === nodeId);
        const next = draft.trim();
        if (!generating && item && next && next !== item.content) {
          onUpdateNodeContent(nodeId, next);
        }
      }
      setEditingId(null);
      setDraft('');
    },
    [doc, draft, generating, onUpdateNodeContent],
  );

  const cancel = useCallback(() => {
    setEditingId(null);
    setDraft('');
  }, []);

  const handleItemKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, nodeId: string) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(nodeId);
        if (generating) return; // 生成中禁止新增节点
        const newId = onAddSibling(nodeId);
        if (typeof newId === 'string') {
          setEditingId(newId);
          setDraft('');
        }
      } else if (event.key === 'Tab') {
        event.preventDefault();
        commit(nodeId);
        if (generating) return;
        const newId = onAddChild(nodeId);
        if (typeof newId === 'string') {
          setEditingId(newId);
          setDraft('');
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    },
    [commit, cancel, generating, onAddSibling, onAddChild],
  );

  const renderItem = useCallback(
    (node: OutlineRenderNode) => {
      const { item } = node;
      const isSelected = selectedNodeId === item.nodeId;
      const isEditing = editingId === item.nodeId;
      const hasChildren = node.children.length > 0;
      const isCollapsed = collapsedIds.has(item.nodeId);
      const isExpanded = hasChildren && !isCollapsed;
      const childrenDomId = `outline-children-${item.nodeId}`;
      const toggleLabel = `${isExpanded ? '收起' : '展开'}「${item.content || '空主题'}」的子节点`;

      return (
        <li key={item.nodeId} className={`outline-item level-${Math.min(item.depth, 4)}`}>
          <div
            className={`outline-row${isSelected ? ' selected' : ''}`}
            onClick={() => onSelectNode(item.nodeId)}
          >
            {hasChildren ? (
              <button
                type="button"
                className={`outline-toggle${isExpanded ? ' expanded' : ''}`}
                onClick={(e) => {
                  // 避免触发行选中，按钮只负责展开/收起
                  e.stopPropagation();
                  toggleCollapse(item.nodeId);
                }}
                aria-expanded={isExpanded}
                aria-controls={childrenDomId}
                aria-label={toggleLabel}
                title={toggleLabel}
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
                  <path
                    d="M6 4.5 L10.5 8 L6 11.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              <span className="outline-toggle-spacer" aria-hidden="true" />
            )}
            <span className="outline-bullet" aria-hidden="true" />
            {isEditing ? (
              <input
                ref={inputRef}
                className="outline-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(item.nodeId)}
                onKeyDown={(e) => handleItemKeyDown(e, item.nodeId)}
                aria-label="编辑大纲条目"
              />
            ) : (
              <span
                className={`outline-text${item.content ? '' : ' placeholder'}`}
                onDoubleClick={() => beginEdit(item.nodeId, item.content)}
                title="双击编辑"
              >
                {item.content || '空主题'}
              </span>
            )}
          </div>
          {hasChildren && (
            <div
              id={childrenDomId}
              className={`outline-collapse${isCollapsed ? '' : ' open'}`}
            >
              <div className="outline-collapse-inner">
                <ul className="outline-children">{node.children.map(renderItem)}</ul>
              </div>
            </div>
          )}
        </li>
      );
    },
    [
      selectedNodeId,
      editingId,
      draft,
      collapsedIds,
      onSelectNode,
      beginEdit,
      commit,
      handleItemKeyDown,
      toggleCollapse,
    ],
  );

  const rootEditing = editingId === 'root';

  return (
    <div className="outline-pane" role="region" aria-label="文字大纲模式">
      <article className="outline-doc">
        <h1
          className={`outline-title${rootEditing ? ' editing' : ''}`}
          onDoubleClick={() => beginEdit('root', doc.rootContent)}
          title="双击编辑标题"
        >
          {rootEditing ? (
            <input
              ref={inputRef}
              className="outline-input outline-title-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit('root')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault();
                  if (e.key === 'Enter') commit('root');
                  else cancel();
                }
              }}
              aria-label="编辑文档标题"
            />
          ) : (
            doc.rootContent || '未命名导图'
          )}
        </h1>
        <ul className="outline-list">{nested.map(renderItem)}</ul>
      </article>
    </div>
  );
}
