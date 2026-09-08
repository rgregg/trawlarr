import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
} from '@xyflow/react';
import type { Connection, Edge, Node, NodeProps } from '@xyflow/react';
import type { FlowDefinition } from '@trawlarr/core';
import {
  addPluginNode,
  autoLayout,
  connectNodes,
  definitionsEqual,
  deleteCanvasSelection,
  insertNodeOnEdge,
  nextNodeId,
  pushHistory,
  redoHistory,
  settledLayout,
  startNodeId,
  toCanvas,
  undoHistory,
} from './flow-canvas-model.js';
import type {
  CanvasHistory,
  CanvasLayout,
  CanvasNodeData,
  CanvasPosition,
  EditorPlugin,
  ValidationProblem,
} from './flow-canvas-model.js';
import { NodeConfig } from './NodeConfig.js';
import { layoutsEqual } from './flow-layout-model.js';
import '@xyflow/react/dist/style.css';
import '../../styles/screens/flow-editor.css';

export interface FlowCanvasProps {
  definition: FlowDefinition;
  plugins: EditorPlugin[];
  problems: ValidationProblem[];
  onChange: (definition: FlowDefinition) => void;
  initialLayout: CanvasLayout;
  onLayoutChange: (layout: CanvasLayout) => void;
  disabled?: boolean;
}

type EditorNode = Node<
  CanvasNodeData & { configure: (id: string) => void; readOnly: boolean },
  'plugin'
>;
type EditorEdge = Edge<{ edgeIndex: number; problems: string[] }>;

function PluginNode({ data, selected }: NodeProps<EditorNode>): JSX.Element {
  const { node, plugin, outputs } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(node.id);
  }, [node.id, outputs, updateNodeInternals]);
  const warning = !plugin ? 'Plugin unavailable' : !plugin.enabled ? 'Plugin disabled' : null;
  // Metadata is only an accent. Arbitrary HTML/icons and styles never enter the page.
  const accent = plugin?.details.style.borderColor;
  const style = {
    '--plugin-accent': accent && CSS.supports('color', accent) ? accent : 'var(--line-strong)',
  } as CSSProperties;
  return (
    <div
      className={[
        'flow-canvas-node',
        selected ? 'is-selected' : '',
        data.problems.length ? 'has-problems' : '',
        data.unreachable ? 'is-unreachable' : '',
      ].join(' ')}
      style={style}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="input"
        isConnectable={!data.readOnly}
        aria-label={`Input of ${node.id}`}
      />
      <span className="flow-node-input-label">
        {data.protectedStart ? 'Start' : data.errorEntry ? 'On flow error' : 'Input'}
      </span>
      <header>
        <span className="flow-node-glyph" aria-hidden="true">
          {data.protectedStart ? '▶' : '◇'}
        </span>
        <div className="flow-node-title">
          <strong title={plugin?.name ?? node.pluginId}>{plugin?.name ?? node.pluginId}</strong>
          <span className="flow-node-id" title={node.id}>
            {node.id}
          </span>
          {data.protectedStart && <span className="flow-node-start">Protected start</span>}
          {data.errorEntry && <span className="flow-node-start">Error entry</span>}
        </div>
        <button
          type="button"
          className="nodrag nopan flow-node-configure"
          onClick={() => data.configure(node.id)}
          aria-label={`Configure ${plugin?.name ?? node.pluginId}, node ${node.id}`}
          title="Configure (or double-click the node)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
            <path d="M8 3v6m8 0v6m-6 0v6" strokeWidth="3" />
          </svg>
        </button>
      </header>
      {outputs.length === 0 && (
        <p className="flow-node-status">{plugin ? 'Terminal step' : 'No declared outputs'}</p>
      )}
      {warning && <p className="flow-node-status flow-canvas-warning">{warning}</p>}
      {data.unreachable && (
        <p className="flow-node-status flow-canvas-warning">Unreachable from any entry</p>
      )}
      {data.problems.length > 0 && (
        <p className="flow-node-problems" title={data.problems.join('\n')}>
          {data.problems.length} validation issue(s)
        </p>
      )}
      {outputs.length > 0 && (
        <div className="flow-node-outputs">
          {outputs.map((output) => (
            <div
              className={`flow-node-output${output.missing ? ' is-missing' : ''}`}
              key={output.number}
              title={output.tooltip}
            >
              <b>
                {output.number}
                {output.missing && ' !'}
              </b>
              <span className="flow-node-output-description">
                {output.missing ? 'Missing output' : output.tooltip || `Output ${output.number}`}
              </span>
              <Handle
                type="source"
                position={Position.Bottom}
                id={String(output.number)}
                isConnectable={!output.missing && !data.readOnly}
                aria-label={`Output ${output.number} of ${node.id}: ${output.tooltip}`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { plugin: PluginNode };
const dragType = 'application/x-trawlarr-plugin';

function CanvasEditor({
  definition,
  plugins,
  problems,
  onChange,
  initialLayout,
  onLayoutChange,
  disabled = false,
}: FlowCanvasProps): JSX.Element {
  const flow = useReactFlow<EditorNode, EditorEdge>();
  const [nodes, setNodes] = useNodesState<EditorNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>([]);
  const [history, setHistory] = useState<CanvasHistory>(() => ({
    past: [],
    present: { definition, layout: { ...autoLayout(definition, plugins), ...initialLayout } },
    future: [],
  }));
  const historyRef = useRef(history);
  const nodeSequence = useRef(1);
  const [configId, setConfigId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [insertMode, setInsertMode] = useState(false);
  const [pendingInsert, setPendingInsert] = useState<{
    plugin: EditorPlugin;
    position: CanvasPosition;
  } | null>(null);
  const [insertOutput, setInsertOutput] = useState('');
  const start = startNodeId(definition, plugins);
  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedEdges = edges.filter((edge) => edge.selected);
  const selectedEdge = selectedEdges.length === 1 ? selectedEdges[0] : undefined;
  const layout = history.present.layout;

  const remember = useCallback((next: CanvasHistory): void => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  useEffect(() => {
    if (!definitionsEqual(definition, historyRef.current.present.definition)) {
      remember({
        past: [],
        present: {
          definition,
          layout: { ...autoLayout(definition, plugins), ...historyRef.current.present.layout },
        },
        future: [],
      });
    }
  }, [definition, plugins, remember]);

  useEffect(() => {
    const projected = toCanvas(definition, plugins, problems, layout);
    setNodes((previous) =>
      projected.nodes.map((node) => {
        const existing = previous.find((candidate) => candidate.id === node.id);
        return {
          ...existing,
          ...node,
          position: existing?.dragging ? existing.position : node.position,
          data: { ...node.data, configure: setConfigId, readOnly: disabled },
        };
      }),
    );
    setEdges((previous) =>
      projected.edges.map((edge, edgeIndex) => ({
        ...edge,
        selected: previous.find((existing) => existing.id === edge.id)?.selected ?? false,
        className: edge.data.problems.length ? 'flow-edge-invalid' : '',
        ariaLabel: `${edge.source}, ${edge.label}, to ${edge.target}${edge.data.problems.length ? `: ${edge.data.problems.join('; ')}` : ''}`,
        data: { edgeIndex, problems: edge.data.problems },
      })),
    );
  }, [definition, plugins, problems, layout, disabled, setNodes, setEdges]);

  const commit = (next: FlowDefinition, nextLayout: CanvasLayout = layout): void => {
    if (disabled) return;
    const current = historyRef.current;
    remember(pushHistory(current, { definition: next, layout: nextLayout }));
    if (!definitionsEqual(definition, next)) onChange(next);
    if (!layoutsEqual(current.present.layout, nextLayout)) onLayoutChange(nextLayout);
  };

  const travel = (direction: 'undo' | 'redo'): void => {
    if (disabled) return;
    const previousLayout = historyRef.current.present.layout;
    const next =
      direction === 'undo' ? undoHistory(historyRef.current) : redoHistory(historyRef.current);
    remember(next);
    if (!definitionsEqual(definition, next.present.definition)) onChange(next.present.definition);
    if (!layoutsEqual(previousLayout, next.present.layout)) onLayoutChange(next.present.layout);
    setNotice(direction === 'undo' ? 'Undid the last change.' : 'Redid the last change.');
  };

  const removeSelection = (): void => {
    if (disabled) return;
    commit(
      deleteCanvasSelection(
        definition,
        selectedNodes.map((node) => node.id),
        selectedEdges.map((edge) => edge.data!.edgeIndex),
        plugins,
      ),
    );
    setNotice(
      'Selection deleted. Only unambiguous single-successor paths are reconnected. Start is protected.',
    );
    setInsertMode(false);
    setPendingInsert(null);
  };

  const connect = (connection: Connection, replacingIndex?: number): void => {
    if (!connection.source || !connection.target || connection.sourceHandle === null) return;
    const next = connectNodes(
      definition,
      {
        fromNodeId: connection.source,
        toNodeId: connection.target,
        outputNumber: Number(connection.sourceHandle),
      },
      plugins,
      replacingIndex,
    );
    if (next === definition) {
      setNotice(
        'Connection unchanged: use a declared output and reconnect an existing line rather than wiring its output twice.',
      );
    } else {
      commit(next);
      setNotice('Connection updated.');
    }
  };

  const place = (plugin: EditorPlugin, position: CanvasPosition, outputNumber?: number): void => {
    if (disabled) return;
    if (insertMode && !selectedEdge) {
      setNotice('Select exactly one connection, or turn off insertion mode before adding.');
      return;
    }
    if (insertMode && selectedEdge) {
      if (
        plugin.isStartPlugin ||
        plugin.details.isStartPlugin ||
        plugin.details.outputs.length === 0
      ) {
        setNotice('Choose a non-Start component with an output to insert on this connection.');
        return;
      }
      if (outputNumber === undefined && plugin.details.outputs.length > 1) {
        setPendingInsert({ plugin, position });
        setInsertOutput(String(plugin.details.outputs[0]!.number));
        return;
      }
    }
    // Node IDs only need flow-local uniqueness. randomUUID requires HTTPS,
    // while daemons are commonly accessed over plain HTTP on a home LAN.
    const id = nextNodeId(definition, nodeSequence.current);
    nodeSequence.current = Number(id.slice('node-'.length)) + 1;
    const next =
      insertMode && selectedEdge
        ? insertNodeOnEdge(
            definition,
            selectedEdge.data!.edgeIndex,
            plugin,
            id,
            outputNumber ?? plugin.details.outputs[0]!.number,
            plugins,
          )
        : addPluginNode(definition, plugin, id, plugins);
    if (next === definition) {
      setNotice(
        'This component cannot be added. Only one Start is allowed and disabled plugins cannot be added.',
      );
      return;
    }
    commit(next, { ...layout, [id]: position });
    setNotice(`Added ${plugin.name}. Configure its inputs and connect its outputs.`);
    setInsertMode(false);
    setPendingInsert(null);
  };

  const addFromPalette = (plugin: EditorPlugin): void => {
    const center = flow.screenToFlowPosition({
      x: canvasBounds.current?.getBoundingClientRect().left ?? 0,
      y: canvasBounds.current?.getBoundingClientRect().top ?? 0,
    });
    const offset = (definition.nodes.length % 6) * 35;
    const source = selectedEdge ? nodes.find((node) => node.id === selectedEdge.source) : undefined;
    const target = selectedEdge ? nodes.find((node) => node.id === selectedEdge.target) : undefined;
    place(
      plugin,
      insertMode && source && target
        ? {
            x: (source.position.x + target.position.x) / 2,
            y: (source.position.y + target.position.y) / 2 + 80,
          }
        : { x: center.x + 100 + offset, y: center.y + 100 + offset },
    );
  };

  const canvasBounds = useRef<HTMLDivElement>(null);
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const plugin = plugins.find(
      (candidate) => candidate.id === event.dataTransfer.getData(dragType),
    );
    if (plugin) place(plugin, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (
      target.closest('input, textarea, select, button, dialog, [contenteditable="true"]') ||
      disabled
    ) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      travel(event.shiftKey ? 'redo' : 'undo');
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      travel('redo');
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeSelection();
    }
  };

  const visiblePlugins = plugins
    .filter((plugin) =>
      `${plugin.name} ${plugin.id} ${plugin.description} ${plugin.tags} ${plugin.source}`
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
    )
    .sort(
      (left, right) =>
        left.details.sidebarPosition - right.details.sidebarPosition ||
        left.name.localeCompare(right.name),
    );
  const configured = definition.nodes.find((node) => node.id === configId);

  return (
    <section className="flow-canvas-editor" aria-label="Visual flow editor" onKeyDown={keyboard}>
      <div className="flow-canvas-toolbar" aria-label="Canvas actions">
        <button
          type="button"
          disabled={disabled || history.past.length === 0}
          onClick={() => travel('undo')}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={disabled || history.future.length === 0}
          onClick={() => travel('redo')}
        >
          Redo
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            commit(definition, autoLayout(definition, plugins));
            window.requestAnimationFrame(() => {
              void flow.fitView({ padding: 0.2, duration: 250 });
            });
          }}
        >
          Auto-layout
        </button>
        <button
          type="button"
          onClick={() => {
            void flow.fitView({ padding: 0.2, duration: 250 });
          }}
        >
          Fit view
        </button>
        <button
          type="button"
          className="btn-danger"
          disabled={
            disabled ||
            (selectedNodes.every((node) => node.id === start) && selectedEdges.length === 0)
          }
          onClick={removeSelection}
        >
          Delete selected
        </button>
        <span className="detail">
          Layout saves automatically without changing the flow version.
        </span>
      </div>
      <p className="flow-canvas-help">
        Drag components onto the canvas. Connect an output handle to an input. Drag a line’s
        endpoint to reconnect. Double-click a node to configure. Shift-drag to select several nodes;
        Delete removes the selection.
      </p>
      {start === undefined && (
        <p className="flow-canvas-warning">
          No Start is present. Add a Start component from the palette.
        </p>
      )}
      <div className="flow-canvas-workspace">
        <div
          className="flow-canvas-surface"
          ref={canvasBounds}
          onDrop={onDrop}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
          }}
        >
          <ReactFlow<EditorNode, EditorEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              const allowed = changes.filter(
                (change) => change.type !== 'remove' && (!disabled || change.type !== 'position'),
              );
              setNodes((current) => applyNodeChanges(allowed, current));
              const currentLayout = historyRef.current.present.layout;
              const nextLayout = settledLayout(currentLayout, allowed);
              if (nextLayout !== currentLayout) commit(definition, nextLayout);
            }}
            onEdgesChange={onEdgesChange}
            onConnect={(connection) => connect(connection)}
            onReconnect={(edge, connection) => connect(connection, edge.data?.edgeIndex)}
            onNodeDoubleClick={(_, node) => setConfigId(node.id)}
            nodesDraggable={!disabled}
            nodesConnectable={!disabled}
            edgesReconnectable={!disabled}
            deleteKeyCode={null}
            multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
            selectionKeyCode="Shift"
            minZoom={0.1}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            defaultEdgeOptions={{ type: 'smoothstep', interactionWidth: 24 }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor="var(--accent-soft)"
              nodeStrokeColor="var(--accent)"
            />
          </ReactFlow>
          {definition.nodes.length === 0 && (
            <p className="flow-canvas-empty">Add a Start component to begin your flow.</p>
          )}
        </div>
        <aside className="flow-component-palette" aria-label="Component palette">
          <h2>Components</h2>
          <label htmlFor="flow-plugin-search">Search components</label>
          <input
            id="flow-plugin-search"
            type="search"
            placeholder="Name, tag, or plugin ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <p className="help">
            Drag a component left, or use Add. Installed plugins run as the service user, not in a
            sandbox.
          </p>
          {selectedEdge && (
            <div className="flow-palette-insert">
              <label>
                <input
                  type="checkbox"
                  checked={insertMode}
                  disabled={disabled}
                  onChange={(event) => {
                    setInsertMode(event.target.checked);
                    setPendingInsert(null);
                  }}
                />
                Insert on selected connection
              </label>
              <p className="help">
                {selectedEdge.source} → {selectedEdge.target}
              </p>
            </div>
          )}
          {insertMode && !selectedEdge && (
            <div>
              <p className="flow-canvas-warning">
                Select exactly one connection to insert a component.
              </p>
              <button
                type="button"
                onClick={() => {
                  setInsertMode(false);
                  setPendingInsert(null);
                }}
              >
                Cancel insertion
              </button>
            </div>
          )}
          {pendingInsert && selectedEdge && (
            <fieldset>
              <legend>Continue through which output?</legend>
              <p>{pendingInsert.plugin.name}</p>
              <select
                aria-label="Inserted component continuation output"
                value={insertOutput}
                onChange={(event) => setInsertOutput(event.target.value)}
              >
                {pendingInsert.plugin.details.outputs.map((output) => (
                  <option key={output.number} value={output.number}>
                    {output.number}: {output.tooltip}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-primary"
                disabled={disabled}
                onClick={() =>
                  place(pendingInsert.plugin, pendingInsert.position, Number(insertOutput))
                }
              >
                Insert component
              </button>
              <button type="button" onClick={() => setPendingInsert(null)}>
                Cancel
              </button>
            </fieldset>
          )}
          <div className="flow-palette-items">
            {visiblePlugins.map((plugin) => {
              const duplicateStart =
                (plugin.isStartPlugin || plugin.details.isStartPlugin) && start !== undefined;
              const duplicateError =
                plugin.details.pType === 'onFlowError' &&
                definition.nodes.some((node) =>
                  plugins.some(
                    (candidate) =>
                      candidate.id === node.pluginId && candidate.details.pType === 'onFlowError',
                  ),
                );
              const unavailable = disabled || !plugin.enabled || duplicateStart || duplicateError;
              return (
                <article
                  className="flow-palette-item"
                  key={plugin.id}
                  draggable={!unavailable}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(dragType, plugin.id);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                >
                  <strong>{plugin.name}</strong>
                  <p title={plugin.description}>{plugin.description}</p>
                  <small>{plugin.tags || plugin.source}</small>
                  <button
                    type="button"
                    disabled={unavailable}
                    onClick={() => addFromPalette(plugin)}
                    aria-label={`Add ${plugin.name}`}
                  >
                    {!plugin.enabled
                      ? 'Disabled'
                      : duplicateStart
                        ? 'Start already present'
                        : duplicateError
                          ? 'On Error already present'
                          : 'Add'}
                  </button>
                </article>
              );
            })}
            {visiblePlugins.length === 0 && <p>No components match this search.</p>}
          </div>
        </aside>
      </div>
      <p className="flow-canvas-notice" role="status">
        {notice}
      </p>
      {problems.length > 0 && (
        <div className="flow-canvas-validation" aria-label="Flow validation problems">
          <h3>
            {problems.length} validation {problems.length === 1 ? 'problem' : 'problems'}
          </h3>
          <ul>
            {problems.map((problem, index) => (
              <li key={index}>
                {problem.nodeId && <strong>{problem.nodeId}: </strong>}
                {problem.message}
                {problem.edge && (
                  <span>
                    {' '}
                    ({problem.edge.fromNodeId}, output {problem.edge.outputNumber} →{' '}
                    {problem.edge.toNodeId})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {configured && (
        <NodeConfig
          key={configured.id}
          node={configured}
          plugin={plugins.find((plugin) => plugin.id === configured.pluginId)}
          disabled={disabled}
          onClose={() => setConfigId(null)}
          onSave={(node) => {
            commit({
              ...definition,
              nodes: definition.nodes.map((current) => (current.id === node.id ? node : current)),
            });
            setConfigId(null);
          }}
        />
      )}
    </section>
  );
}

export function FlowCanvas(props: FlowCanvasProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasEditor {...props} />
    </ReactFlowProvider>
  );
}
