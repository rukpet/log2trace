import { globalStyle, keyframes, style, styleVariants } from '@vanilla-extract/css';

// ---- :host rules (Shadow DOM root) ----
globalStyle(':host', {
  display: 'block',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
});
globalStyle(':host(:focus)', {
  outline: 'none',
});
globalStyle(':host(.full-width)', {
  width: '100%',
  maxWidth: '100%',
});

// ---- Global element rules ----
globalStyle('code', {
  background: 'rgba(0,0,0,0.1)',
  padding: '2px 6px',
  borderRadius: 3,
  fontFamily: "'Courier New', monospace",
});

// ---- Keyframes ----
const spin = keyframes({
  '0%': { transform: 'rotate(0deg)' },
  '100%': { transform: 'rotate(360deg)' },
});

// ---- Trace viewer layout ----
export const traceViewer = style({
  padding: 20,
  boxSizing: 'border-box',
});

export const traceHeader = style({
  marginBottom: 20,
  paddingBottom: 10,
  borderBottom: '2px solid #ddd',
});
globalStyle(`${traceHeader} h3`, {
  margin: '0 0 10px 0',
  fontSize: 18,
  color: '#333',
});

export const traceStats = style({
  display: 'flex',
  gap: 20,
  fontSize: 14,
  color: '#666',
});

export const traceBody = style({
  display: 'flex',
  overflow: 'hidden',
});

export const traceChart = style({
  position: 'relative',
  cursor: 'default',
  userSelect: 'none',
  overflow: 'hidden',
  height: '100%',
});
globalStyle(`${traceBody} > ${traceChart}`, {
  flex: 1,
  minWidth: 0,
});

// ---- Legend ----
export const legend = style({
  display: 'flex',
  gap: 16,
  flexWrap: 'wrap',
});

export const legendItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
  color: '#666',
});

export const legendColor = style({
  width: 14,
  height: 14,
  borderRadius: 3,
});

// ---- Message states ----
export const message = style({
  padding: 40,
  textAlign: 'center',
  borderRadius: 8,
  background: '#f5f5f5',
});

export const messageLoading = style({
  selectors: {
    [`${message}&`]: { color: '#666' },
  },
});

export const messageEmpty = style({
  selectors: {
    [`${message}&`]: { color: '#999' },
  },
});

export const messageError = style({
  selectors: {
    [`${message}&`]: { background: '#ffebee', color: '#c62828' },
  },
});

// ---- Spinner ----
export const spinner = style({
  display: 'inline-block',
  width: 20,
  height: 20,
  border: '3px solid #f3f3f3',
  borderTop: '3px solid #3498db',
  borderRadius: '50%',
  animation: `${spin} 1s linear infinite`,
  marginBottom: 10,
});

// ---- Span labels sidebar ----
export const spanLabelsContainer = style({
  position: 'absolute',
  left: 0,
  width: 250,
  top: 0,
  bottom: 0,
  paddingLeft: 20,
  boxSizing: 'border-box',
  pointerEvents: 'none',
  zIndex: 10,
  background: 'white',
});

export const spanLabelFixed = style({
  position: 'absolute',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  pointerEvents: 'auto',
  fontSize: 12,
  lineHeight: 1.2,
  padding: '2px 5px',
  color: '#333',
});

export const statusIcon = style({
  display: 'inline-block',
  width: 12,
  fontSize: 10,
});

// ---- Timeline ----
export const timelineOverlay = style({
  position: 'absolute',
  left: 250,
  right: 80,
  top: 0,
  height: 40,
  zIndex: 5,
  pointerEvents: 'none',
  borderBottom: '2px solid #ddd',
});

export const timelineClip = style({
  position: 'absolute',
  left: 250,
  right: 80,
  top: 0,
  bottom: 0,
  overflow: 'hidden',
});

export const timelineContainer = style({
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  willChange: 'transform',
});

export const timeline = style({
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 40,
});

export const timelineTick = style({
  position: 'absolute',
  top: 0,
  height: '100%',
  borderLeft: '1px solid #ddd',
});

export const timelineLabel = style({
  position: 'absolute',
  top: 5,
  left: 5,
  fontSize: 11,
  color: '#666',
  whiteSpace: 'nowrap',
});

// ---- Spans ----
export const spanRow = style({
  position: 'absolute',
  left: 0,
  right: 0,
  ':hover': {
    background: '#f5f5f5',
  },
});

export const spanBar = style({
  position: 'absolute',
  height: '100%',
  borderRadius: 3,
  cursor: 'pointer',
  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  transition: 'transform 0.2s, box-shadow 0.2s',
  transformOrigin: 'center center',
  ':hover': {
    transform: 'scaleY(1.2)',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    zIndex: 10,
  },
});

export const spanBarSelected = style({
  selectors: {
    [`${spanBar}&`]: {
      outline: '3px solid #007bff',
      outlineOffset: 2,
      zIndex: 15,
    },
  },
});

export const spanDuration = style({
  position: 'absolute',
  left: '100%',
  marginLeft: 5,
  whiteSpace: 'nowrap',
  fontSize: 11,
  color: '#666',
});

export const spanEvent = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 2,
  background: 'rgba(255,255,255,0.8)',
  cursor: 'help',
  transition: 'transform 0.2s',
  transformOrigin: 'center center',
  ':hover': {
    transform: 'scaleX(2)',
  },
});

// ---- Detail panel (right sidebar) ----
export const detailPanel = style({
  display: 'none',
  flexShrink: 0,
  borderLeft: '2px solid #ddd',
  padding: 15,
  maxHeight: 'inherit',
});

export const detailPanelVisible = style({
  selectors: {
    [`${detailPanel}&`]: {
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
  },
});

export const detailPanelHeader = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 10,
});
globalStyle(`${detailPanelHeader} h3`, {
  margin: 0,
  fontSize: 16,
  color: '#333',
});

export const detailPanelClose = style({
  padding: '4px 10px',
  border: '1px solid #ddd',
  background: 'white',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
  transition: 'all 0.2s',
  ':hover': {
    background: '#f5f5f5',
    borderColor: '#999',
  },
});

export const detailContent = style({
  color: '#666',
  fontFamily: "'Courier New', monospace",
  fontSize: 13,
  whiteSpace: 'pre',
  background: '#f5f5f5',
  padding: 10,
  borderRadius: 4,
  flex: 1,
  overflow: 'auto',
});

// ---- Zoom controls ----
export const zoomControls = style({
  position: 'sticky',
  bottom: 0,
  zIndex: 100,
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  padding: 10,
  background: 'rgba(255,255,255,0.95)',
  borderTop: '1px solid #ddd',
});

export const zoomBtn = style({
  padding: '6px 12px',
  border: '1px solid #ddd',
  background: 'white',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 'bold',
  transition: 'all 0.2s',
  ':hover': {
    background: '#f5f5f5',
    borderColor: '#999',
  },
  ':active': {
    transform: 'scale(0.95)',
  },
});

export const zoomIn = style({
  selectors: {
    [`${zoomBtn}&`]: { marginLeft: 'auto' },
  },
});

export const zoomOut = style({});

export const zoomReset = style({});

export const zoomDisplay = style({
  fontSize: 14,
  fontWeight: 500,
  color: '#666',
  minWidth: 50,
  textAlign: 'center',
});

// ---- Tooltip ----
export const spanTooltip = style({
  position: 'fixed',
  background: 'white',
  border: '1px solid #ddd',
  borderRadius: 6,
  padding: 12,
  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  zIndex: 1000,
  maxWidth: 350,
  pointerEvents: 'none',
  display: 'none',
  fontSize: 13,
});

export const tooltipHeader = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 8,
  paddingBottom: 8,
  borderBottom: '1px solid #eee',
});
globalStyle(`${tooltipHeader} strong`, {
  color: '#333',
  fontSize: 14,
});

export const tooltipStatus = style({
  padding: '2px 8px',
  borderRadius: 3,
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
});

export const tooltipStatusVariants = styleVariants({
  ok:    { backgroundColor: '#d4edda', color: '#155724' },
  error: { backgroundColor: '#f8d7da', color: '#721c24' },
  unset: { backgroundColor: '#e2e3e5', color: '#383d41' },
});

export const tooltipOperation = style({
  color: '#555',
  marginBottom: 10,
  fontWeight: 500,
  wordBreak: 'break-word',
});

export const tooltipInfo = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
});

export const tooltipRow = style({
  display: 'flex',
  justifyContent: 'space-between',
  gap: 10,
});

export const tooltipLabel = style({
  color: '#666',
  fontWeight: 500,
});

export const tooltipValue = style({
  color: '#333',
  fontFamily: "'Courier New', monospace",
  fontSize: 12,
  wordBreak: 'break-all',
});

export const tooltipHint = style({
  marginTop: 8,
  paddingTop: 8,
  borderTop: '1px solid #eee',
  color: '#999',
  fontSize: 11,
  fontStyle: 'italic',
  textAlign: 'center',
});
