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
  color: '#333',
  fontSize: 13,
  background: '#f8f9fa',
  padding: 0,
  borderRadius: 4,
  flex: 1,
  overflow: 'auto',
});

// ---- Detail panel sections (native <details>/<summary>) ----
export const detailSection = style({
  borderBottom: '1px solid #e9ecef',
});

export const detailSectionHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  color: '#495057',
  userSelect: 'none',
  listStyle: 'none',
  ':hover': {
    background: '#e9ecef',
  },
  '::marker': { display: 'none' },
  '::before': {
    content: '"\\25BC"',
    fontSize: 9,
    transition: 'transform 0.15s',
    display: 'inline-block',
  },
});
globalStyle(`${detailSectionHeader}::-webkit-details-marker`, {
  display: 'none',
});
globalStyle(`details:not([open]) > ${detailSectionHeader}::before`, {
  transform: 'rotate(-90deg)',
});

export const detailSectionBody = style({
  padding: '4px 12px 12px',
});

export const detailOverviewGrid = style({
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '6px 12px',
  alignItems: 'baseline',
});

export const detailLabel = style({
  fontSize: 12,
  color: '#6c757d',
  fontWeight: 500,
  whiteSpace: 'nowrap',
});

export const detailValue = style({
  fontSize: 13,
  color: '#212529',
  wordBreak: 'break-all',
});

export const detailValueMono = style({
  fontSize: 12,
  color: '#212529',
  fontFamily: "'Courier New', monospace",
  wordBreak: 'break-all',
});

export const detailSpanName = style({
  fontSize: 14,
  fontWeight: 600,
  color: '#212529',
  wordBreak: 'break-word',
  padding: '4px 12px 0',
});

export const detailStatusBadge = style({
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: 3,
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
});

export const detailStatusVariants = styleVariants({
  ok:    { backgroundColor: '#d4edda', color: '#155724' },
  error: { backgroundColor: '#f8d7da', color: '#721c24' },
  unset: { backgroundColor: '#e2e3e5', color: '#383d41' },
});

export const detailAttrTable = style({
  width: '100%',
  borderCollapse: 'collapse',
});
globalStyle(`${detailAttrTable} tr:nth-child(even)`, {
  background: '#f1f3f5',
});
globalStyle(`${detailAttrTable} td`, {
  padding: '4px 8px',
  fontSize: 12,
  verticalAlign: 'top',
  borderBottom: '1px solid #e9ecef',
});
globalStyle(`${detailAttrTable} td:first-child`, {
  fontFamily: "'Courier New', monospace",
  color: '#495057',
  whiteSpace: 'nowrap',
  fontWeight: 500,
  maxWidth: 180,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});
globalStyle(`${detailAttrTable} td:last-child`, {
  color: '#212529',
  wordBreak: 'break-word',
  fontFamily: "'Courier New', monospace",
});

export const detailEventCard = style({
  border: '1px solid #dee2e6',
  borderRadius: 4,
  marginBottom: 8,
  overflow: 'hidden',
});

export const detailEventHeader = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 10px',
  background: '#e9ecef',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  userSelect: 'none',
  gap: 8,
  listStyle: 'none',
  '::marker': { display: 'none' },
  '::before': {
    content: '"\\25BC"',
    fontSize: 8,
    transition: 'transform 0.15s',
    display: 'inline-block',
    flexShrink: 0,
  },
});
globalStyle(`${detailEventHeader}::-webkit-details-marker`, {
  display: 'none',
});
globalStyle(`details:not([open]) > ${detailEventHeader}::before`, {
  transform: 'rotate(-90deg)',
});

export const detailEventName = style({
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: '#333',
});

export const detailEventTimestamp = style({
  fontSize: 11,
  color: '#6c757d',
  whiteSpace: 'nowrap',
  flexShrink: 0,
});

export const detailEventBody = style({
  padding: 0,
});


export const detailBadge = style({
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  background: '#6c757d',
  color: 'white',
  marginLeft: 6,
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

// ---- Filter bar ----
export const filterBarContainer = style({
  borderBottom: '2px solid #ddd',
  marginBottom: 16,
});

export const filterRow = style({
  display: 'flex',
  alignItems: 'flex-end',
  gap: 16,
  flexWrap: 'wrap',
  padding: '12px 20px',
});

export const filterRowExternal = style({
  selectors: {
    [`${filterRow}&`]: {
      background: '#f0f4ff',
      borderBottom: '1px solid #d0d8e8',
    },
  },
});

export const filterRowLocal = style({
  selectors: {
    [`${filterRow}&`]: {
      background: '#f0fff4',
      borderBottom: '1px solid #c8e6c9',
    },
  },
});

export const filterRowLabel = style({
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  fontWeight: 600,
  alignSelf: 'center',
  whiteSpace: 'nowrap',
});

export const filterRowLabelExternal = style({
  selectors: {
    [`${filterRowLabel}&`]: {
      color: '#4A90E2',
    },
  },
});

export const filterRowLabelLocal = style({
  selectors: {
    [`${filterRowLabel}&`]: {
      color: '#2ECC71',
    },
  },
});

export const filterField = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
});

export const filterLabel = style({
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
});

export const filterLabelExternal = style({
  selectors: {
    [`${filterLabel}&`]: {
      color: '#4A90E2',
    },
  },
});

export const filterLabelLocal = style({
  selectors: {
    [`${filterLabel}&`]: {
      color: '#2ECC71',
    },
  },
});

export const filterRequiredMarker = style({
  color: '#c62828',
  marginLeft: 2,
});

export const filterInput = style({
  padding: '6px 10px',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: 13,
  background: 'white',
  color: '#333',
  minWidth: 130,
  ':focus': {
    outline: 'none',
    borderColor: '#4A90E2',
    boxShadow: '0 0 0 2px rgba(74,144,226,0.2)',
  },
});

export const filterSelect = style({
  selectors: {
    [`${filterInput}&`]: {
      cursor: 'pointer',
      appearance: 'auto',
    },
  },
});

export const filterCheckboxField = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  paddingTop: 6,
  paddingBottom: 6,
  alignSelf: 'flex-end',
});

export const filterCheckbox = style({
  width: 16,
  height: 16,
  cursor: 'pointer',
  accentColor: '#2ECC71',
});

export const filterCheckboxLabel = style({
  fontSize: 13,
  cursor: 'pointer',
  userSelect: 'none',
  fontWeight: 500,
});

export const filterDatetimeGroup = style({
  display: 'flex',
  gap: 6,
  alignItems: 'center',
});

export const filterDatetimeSeparator = style({
  color: '#999',
  fontSize: 12,
});

export const filterSearchBtn = style({
  padding: '6px 16px',
  border: '1px solid #4A90E2',
  background: '#4A90E2',
  color: 'white',
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  alignSelf: 'flex-end',
  transition: 'all 0.2s',
  ':hover': {
    background: '#357abd',
    borderColor: '#357abd',
  },
  ':active': {
    transform: 'scale(0.97)',
  },
});

export const filterClearBtn = style({
  padding: '6px 12px',
  border: '1px solid #ccc',
  background: 'white',
  color: '#666',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
  alignSelf: 'flex-end',
  transition: 'all 0.2s',
  ':hover': {
    background: '#f5f5f5',
    borderColor: '#999',
    color: '#333',
  },
  ':active': {
    transform: 'scale(0.97)',
  },
});

export const filterEmptyState = style({
  padding: 40,
  textAlign: 'center',
  color: '#999',
  fontSize: 14,
});
