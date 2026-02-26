/**
 * <tw-chart> Web Component
 * 
 * A standalone chart component built with lightweight-charts.
 * 
 * PROPERTIES:
 * - candlesticks: Record<string, RawCandlestick[]>
 *   A map of timeframes (e.g., '1m', '5m', '1H') to arrays of candlestick data.
 *   Candlestick format: { timestamp: number, open: number, high: number, low: number, close: number, volume: number }
 * 
 * - markers: Marker[]
 *   Array of markers to display on the chart (e.g., trade entries/exits).
 *   Marker format: { timestamp: number, price: number, color?: string }
 *   If price > 0, marker is placed at that price. If price is 0, it's placed inside the bar.
 * 
 * - priceLines: PriceLine[]
 *   Array of horizontal price lines or segments to draw.
 *   PriceLine format: { price: number, color: string, isSolid: boolean, label?: string, timestamp?: number }
 *   If timestamp is provided, it draws a segment from that timestamp to the current edge.
 * 
 * EVENTS:
 * - loadMoreCandles: Dispatched when "Load Before" or "Load After" buttons are clicked.
 *   Detail: { days: number, direction: 'before' | 'after' }
 * 
 * KEYBOARD SHORTCUTS:
 * - Alt + I: Toggle scale inversion
 * - Alt + F: Activate Fibonacci tool
 * - Alt + T: Activate Trendline tool
 * - Alt + H: Add horizontal line at current cursor position
 * - Escape: Deactivate current drawing tool
 * - Shift: Hold while drawing trendline to snap horizontally
 * 
 * STYLING:
 * - Set width and height on the element or via CSS. 
 * - The component fills its container (100% width/height).
 */

import {
  createChart,
  CrosshairMode,
  ColorType,
  LineStyle,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
  type MouseEventParams,
  type PriceLineOptions,
  type LineData,
  type SeriesMarkerPrice,
  type SeriesMarkerBar,
} from 'lightweight-charts';

export interface RawCandlestick {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Marker {
  timestamp: number;
  price: number;
  color?: string;
}

export interface PriceLine {
  price: number;
  color: string;
  isSolid: boolean;
  label?: string;
  timestamp?: number;
}

type ActiveTool = 'fibonacci' | 'trendline' | 'horizontalLine' | null;

const TIMEFRAME_SECONDS: Record<string, number> = {
  '1S': 1,
  '10S': 10,
  '1m': 60,
  '5m': 300,
  '1H': 3600,
  '4H': 14400,
  '1D': 86400,
  '1W': 604800,
};

const FIB_LEVELS = [
  { ratio: 0, color: '#808080', label: '0%' },
  { ratio: 0.236, color: '#cc2828', label: '23.6%' },
  { ratio: 0.382, color: '#95cc28', label: '38.2%' },
  { ratio: 0.5, color: '#28cc28', label: '50%' },
  { ratio: 0.618, color: '#28cc95', label: '61.8%' },
  { ratio: 1, color: '#808080', label: '100%' },
  { ratio: 1.272, color: '#95cc28', label: '127.2%' },
  { ratio: 1.618, color: '#2196f3', label: '161.8%' },
];

export class TWChart extends HTMLElement {
  private _candlesticks: Record<string, RawCandlestick[]> = {};
  private _markers: Marker[] = [];
  private _priceLines: PriceLine[] = [];

  private chartContainer: HTMLDivElement | null = null;
  private chart: IChartApi | null = null;
  private mainSeriesApi: ISeriesApi<'Candlestick'> | null = null;
  private ema20SeriesApi: ISeriesApi<'Line'> | null = null;
  private ema200SeriesApi: ISeriesApi<'Line'> | null = null;
  private markSeriesApi: ISeriesApi<'Histogram'> | null = null;
  private volumeSeriesApi: ISeriesApi<'Histogram'> | null = null;
  private seriesMarkersPrimitive: ISeriesMarkersPluginApi<Time> | null = null;

  private activePriceLines: Map<string, IPriceLine> = new Map();
  private activeFibLines: Map<string, IPriceLine> = new Map();
  private activeHorizontalLines: Map<number, IPriceLine> = new Map();
  private activeTrendlineSeries: Map<number, ISeriesApi<'Line'>> = new Map();
  private activeOrderLines: Map<string, ISeriesApi<'Line'>> = new Map();
  private activeOrderPriceLabels: Map<string, IPriceLine> = new Map();
  private previewTrendlineSeries: ISeriesApi<'Line'> | null = null;

  private inverse = false;
  private onlyBefore = false;
  private currentChartTimeframe = '5m';
  private daysToLoad = 1;
  private activeTool: ActiveTool = null;
  private currentCursorPrice: number | null = null;
  private isShiftPressed = false;
  private hasInitialScroll = false;

  // Fibonacci state
  private fibonacciStartPrice: number | null = null;
  private fibonacciEndPrice: number | null = null;
  private fibonacciLevels: PriceLineOptions[] = [];

  // Trendline state
  private trendlineStartPoint: { time: UTCTimestamp, price: number } | null = null;
  private trendlines: { start: { time: UTCTimestamp, price: number }, end: { time: UTCTimestamp, price: number } }[] = [];

  // Horizontal line state
  private horizontalLines: number[] = [];

  // Dragging state
  private isDragging = false;
  private draggingLineType: 'horizontal' | 'trendline-point' | 'trendline-body' | null = null;
  private draggingLineIndex: number | null = null;
  private draggedTrendlinePoint: 'start' | 'end' | null = null;
  private trendlineDragInitialMouseTime: Time | null = null;
  private trendlineDragInitialMousePrice: number | null = null;
  private trendlineDragInitialStart: { time: Time, price: number } | null = null;
  private trendlineDragInitialEnd: { time: Time, price: number } | null = null;

  private DRAG_THRESHOLD_PX = 15;
  private TRENDLINE_BODY_DRAG_THRESHOLD_PX = 5;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.handleResize = this.handleResize.bind(this);
    this.handleContextMenu = this.handleContextMenu.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleGlobalMouseMove = this.handleGlobalMouseMove.bind(this);
    this.handleGlobalMouseUp = this.handleGlobalMouseUp.bind(this);
  }

  set candlesticks(val: Record<string, RawCandlestick[]>) {
    this._candlesticks = val;
    this.updateData();
  }

  get candlesticks() {
    return this._candlesticks;
  }

  set markers(val: Marker[]) {
    this._markers = val;
    this.updateMarkers();
  }

  get markers() {
    return this._markers;
  }

  set priceLines(val: PriceLine[]) {
    this._priceLines = val;
    this.updatePriceLines();
  }

  get priceLines() {
    return this._priceLines;
  }

  connectedCallback() {
    this.render();
    this.initChart();
    this.addEventListeners();
  }

  disconnectedCallback() {
    this.removeEventListeners();
    if (this.chart) {
      this.chart.remove();
      this.chart = null;
    }
  }

  private render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          background: #000;
          position: relative;
          color: white;
        }
        .actions {
          position: absolute;
          top: 0;
          left: 0;
          z-index: 1001;
          display: flex;
          flex-wrap: wrap;
          padding: 10px;
          gap: 10px;
          pointer-events: none;
        }
        .actions > * {
          pointer-events: auto;
        }
        #chart-container {
          width: 100%;
          height: 100%;
        }
        .loading {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          color: white;
        }
      </style>
      <div class="actions">
        <sp-action-group id="timeframe-group" compact select="single"></sp-action-group>
        <sp-action-group compact>
          <sp-action-button id="inverse-btn" quiet>Inverse</sp-action-button>
        </sp-action-group>
        <sp-action-group compact>
          <sp-action-button id="only-before-btn" quiet>Only Before</sp-action-button>
        </sp-action-group>
        <sp-action-group compact>
          <sp-action-button id="fib-btn" quiet>Fibonacci (Alt+F)</sp-action-button>
          <sp-action-button id="clear-fib-btn" quiet style="display:none">Clear Fib</sp-action-button>
        </sp-action-group>
        <sp-action-group compact>
          <sp-action-button id="trend-btn" quiet>Trendline (Alt+T)</sp-action-button>
          <sp-action-button id="clear-trend-btn" quiet style="display:none">Clear Trend</sp-action-button>
        </sp-action-group>
        <sp-action-group compact>
          <sp-action-button id="hline-btn" quiet>H-Line (Alt+H)</sp-action-button>
          <sp-action-button id="clear-hline-btn" quiet style="display:none">Clear H-Lines</sp-action-button>
        </sp-action-group>
        <sp-action-group compact>
          <sp-number-field id="days-to-load" min="1" max="365" value="1"></sp-number-field>
          <sp-action-button id="load-before-btn" quiet>Load Before</sp-action-button>
          <sp-action-button id="load-after-btn" quiet>Load After</sp-action-button>
        </sp-action-group>
      </div>
      <div id="chart-container"></div>
      <div id="loading-msg" class="loading" style="display:none">Loading chart data...</div>
    `;

    this.chartContainer = this.shadowRoot.getElementById('chart-container') as HTMLDivElement;
    this.setupActionButtons();
  }

  private setupActionButtons() {
    if (!this.shadowRoot) return;

    const tfGroup = this.shadowRoot.getElementById('timeframe-group');
    if (tfGroup) {
      ['1S', '10S', '1m', '5m', '1H', '4H', '1D', '1W'].forEach(tf => {
        const btn = document.createElement('sp-action-button');
        btn.value = tf;
        btn.textContent = tf;
        if (tf === this.currentChartTimeframe) btn.setAttribute('selected', '');
        btn.onclick = () => {
          this.currentChartTimeframe = tf;
          this.updateTimeframeSelection();
          this.updateData();
        };
        tfGroup.appendChild(btn);
      });
    }

    this.shadowRoot.getElementById('inverse-btn')!.onclick = () => {
      this.inverse = !this.inverse;
      this.updateChartOptions();
    };

    this.shadowRoot.getElementById('only-before-btn')!.onclick = () => {
      this.onlyBefore = !this.onlyBefore;
      this.updateData();
    };

    this.shadowRoot.getElementById('fib-btn')!.onclick = () => this.activateTool('fibonacci');
    this.shadowRoot.getElementById('clear-fib-btn')!.onclick = () => this.clearFibonacci();
    this.shadowRoot.getElementById('trend-btn')!.onclick = () => this.activateTool('trendline');
    this.shadowRoot.getElementById('clear-trend-btn')!.onclick = () => this.clearTrendlines();
    this.shadowRoot.getElementById('hline-btn')!.onclick = () => this.activateTool('horizontalLine');
    this.shadowRoot.getElementById('clear-hline-btn')!.onclick = () => this.clearHorizontalLines();
    const daysField = this.shadowRoot.getElementById('days-to-load') as any;
    daysField.onchange = (e: any) => {
      this.daysToLoad = parseInt(e.target.value);
    };

    this.shadowRoot.getElementById('load-before-btn')!.onclick = () => {
      this.dispatchEvent(new CustomEvent('loadMoreCandles', {
        detail: { days: this.daysToLoad, direction: 'before' }
      }));
    };

    this.shadowRoot.getElementById('load-after-btn')!.onclick = () => {
      this.dispatchEvent(new CustomEvent('loadMoreCandles', {
        detail: { days: this.daysToLoad, direction: 'after' }
      }));
    };
  }

  private updateTimeframeSelection() {
    if (!this.shadowRoot) return;
    const btns = this.shadowRoot.querySelectorAll('#timeframe-group sp-action-button');
    btns.forEach(btn => {
      if ((btn as any).value === this.currentChartTimeframe) {
        btn.setAttribute('selected', '');
      } else {
        btn.removeAttribute('selected');
      }
    });
    this.hasInitialScroll = false;
  }

  private initChart() {
    if (!this.chartContainer) return;

    this.chart = createChart(this.chartContainer, {
      width: this.offsetWidth || 800,
      height: this.offsetHeight || 600,
      layout: {
        background: { type: ColorType.Solid, color: '#000000' },
        textColor: 'rgba(255, 255, 255, 0.9)',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: 'rgba(197, 203, 206, 0.8)',
        invertScale: this.inverse,
      },
      timeScale: {
        borderColor: 'rgba(197, 203, 206, 0.8)',
        timeVisible: true,
      },
    });

    this.markSeriesApi = this.chart.addSeries(HistogramSeries, {
      priceScaleId: '',
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }),
    });

    this.volumeSeriesApi = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });

    this.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    this.mainSeriesApi = this.chart.addSeries(CandlestickSeries, {
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: 5, minMove: 0.00001 },
    });

    this.ema20SeriesApi = this.chart.addSeries(LineSeries, {
      color: '#FFA500',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'price', precision: 5, minMove: 0.00001 },
    });

    this.ema200SeriesApi = this.chart.addSeries(LineSeries, {
      color: '#9c27b0',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'price', precision: 5, minMove: 0.00001 },
    });

    this.chart.subscribeClick(this.handleChartClick.bind(this));
    this.chart.subscribeCrosshairMove(this.handleCrosshairMove.bind(this));

    window.addEventListener('resize', this.handleResize);

    this.updateData();
  }

  private handleResize() {
    if (this.chart) {
      this.chart.resize(this.offsetWidth, this.offsetHeight);
    }
  }

  private addEventListeners() {
    this.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    this.chartContainer?.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mousemove', this.handleGlobalMouseMove);
    window.addEventListener('mouseup', this.handleGlobalMouseUp);
  }

  private removeEventListeners() {
    this.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.chartContainer?.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mousemove', this.handleGlobalMouseMove);
    window.removeEventListener('mouseup', this.handleGlobalMouseUp);
    window.removeEventListener('resize', this.handleResize);
  }

  private handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    this.deactivateCurrentTool();
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Shift') {
      this.isShiftPressed = true;
    } else if (e.altKey) {
      switch (e.key) {
        case 'i':
        case 'Dead':
          this.inverse = !this.inverse;
          this.updateChartOptions();
          break;
        case 'f':
        case 'ƒ':
          this.activateTool('fibonacci');
          break;
        case 't':
        case '†':
          this.activateTool('trendline');
          break;
        case 'h':
        case '˙':
          if (this.currentCursorPrice !== null) {
            this.horizontalLines.push(this.currentCursorPrice);
            this.updateHorizontalLines();
          }
          break;
      }
    } else if (e.key === 'Escape') {
      this.deactivateCurrentTool();
    }
  }

  private handleKeyUp(e: KeyboardEvent) {
    if (e.key === 'Shift') {
      this.isShiftPressed = false;
    }
  }

  private updateChartOptions() {
    if (this.chart) {
      this.chart.applyOptions({
        rightPriceScale: { invertScale: this.inverse },
      });
    }
    const invBtn = this.shadowRoot?.getElementById('inverse-btn');
    if (invBtn) {
      if (this.inverse) invBtn.setAttribute('selected', '');
      else invBtn.removeAttribute('selected');
    }
  }

  private updateData() {
    if (!this.mainSeriesApi) return;

    const allCandles = this._candlesticks[this.currentChartTimeframe] || [];
    const loadingMsg = this.shadowRoot?.getElementById('loading-msg');
    if (loadingMsg) loadingMsg.style.display = allCandles.length === 0 ? 'block' : 'none';

    const entryMarker = this._markers.length > 0 ? [...this._markers].sort((a, b) => a.timestamp - b.timestamp)[0] : null;
    const timeframeSec = TIMEFRAME_SECONDS[this.currentChartTimeframe] || 300;

    const currentCandlesticks = this.onlyBefore && entryMarker
      ? allCandles.filter(c => c.timestamp < entryMarker.timestamp + timeframeSec)
      : allCandles;

    const candles = currentCandlesticks.map(c => ({
      time: this.timeToLocal(c.timestamp),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    this.mainSeriesApi.setData(candles);

    const ema20 = this.calculateEma(currentCandlesticks, 20).map(ema => ({
      time: this.timeToLocal(ema.time),
      value: ema.value,
    }));
    this.ema20SeriesApi?.setData(ema20);

    const ema200 = this.calculateEma(currentCandlesticks, 200).map(ema => ({
      time: this.timeToLocal(ema.time),
      value: ema.value,
    }));
    this.ema200SeriesApi?.setData(ema200);

    const volumeData = currentCandlesticks.map(c => ({
      time: this.timeToLocal(c.timestamp),
      value: c.volume,
      color: c.close >= c.open ? 'rgba(38, 166, 154, 0.5)' : 'rgba(239, 83, 80, 0.5)',
    }));
    this.volumeSeriesApi?.setData(volumeData);

    const marksData = currentCandlesticks.map(c => {
      const d = new Date(c.timestamp * 1000);
      const color = this.computeMarkColorForBar(d, this.currentChartTimeframe);
      if (!color) return null;
      return {
        time: this.timeToLocal(c.timestamp),
        value: 1,
        color,
      };
    }).filter((v): v is any => v !== null);
    this.markSeriesApi?.setData(marksData);

    this.updateMarkers();
    this.updatePriceLines();

    if (this.chart && candles.length > 0 && !this.hasInitialScroll) {
      this.hasInitialScroll = true;
      if (entryMarker) {
        const entryTime = this.timeToLocal(entryMarker.timestamp);
        setTimeout(() => {
          if (!this.chart) return;
          this.chart.timeScale().setVisibleRange({
            from: (entryTime - timeframeSec * 100) as UTCTimestamp,
            to: (entryTime + timeframeSec * 300) as UTCTimestamp,
          });
        }, 100);
      } else {
        this.chart.timeScale().fitContent();
      }
    }

    const beforeBtn = this.shadowRoot?.getElementById('only-before-btn');
    if (beforeBtn) {
      if (this.onlyBefore) beforeBtn.setAttribute('selected', '');
      else beforeBtn.removeAttribute('selected');
    }
  }

  private updateMarkers() {
    if (!this.mainSeriesApi) return;

    const allCandles = this._candlesticks[this.currentChartTimeframe] || [];
    const timeframeSec = TIMEFRAME_SECONDS[this.currentChartTimeframe] || 300;

    const chartMarkers = this._markers.map(m => {
      const originalCandle = allCandles.find((c, i) => {
        const nextCandle = allCandles[i + 1];
        if (nextCandle) return m.timestamp >= c.timestamp && m.timestamp < nextCandle.timestamp;
        return m.timestamp >= c.timestamp && m.timestamp < c.timestamp + timeframeSec;
      });

      if (originalCandle) {
        if (m.price > 0) {
          return {
            time: this.timeToLocal(originalCandle.timestamp),
            position: 'atPriceMiddle',
            color: m.color || 'rgba(255, 255, 255, 1)',
            shape: 'circle',
            size: 1,
            price: m.price,
          } as SeriesMarkerPrice<UTCTimestamp>;
        }
        return {
          time: this.timeToLocal(originalCandle.timestamp),
          position: 'inBar',
          color: m.color || 'rgba(255, 255, 255, 1)',
          shape: 'circle',
          size: 1,
        } as SeriesMarkerBar<UTCTimestamp>;
      }
      return null;
    }).filter((m): m is any => m !== null);

    if (!this.seriesMarkersPrimitive) {
      this.seriesMarkersPrimitive = createSeriesMarkers(this.mainSeriesApi, chartMarkers);
    } else {
      this.seriesMarkersPrimitive.setMarkers(chartMarkers);
    }
  }

  private updatePriceLines() {
    if (!this.mainSeriesApi || !this.chart) return;

    const allCandles = this._candlesticks[this.currentChartTimeframe] || [];
    const timeframeSec = TIMEFRAME_SECONDS[this.currentChartTimeframe] || 300;

    // Normal Price Lines
    const normalLines = this._priceLines.filter(pl => !pl.timestamp);
    this.updatePriceLineObjects(
      this.mainSeriesApi,
      normalLines,
      this.activePriceLines,
      pl => `${pl.price}-${pl.label || ''}`,
      pl => ({
        price: pl.price,
        color: pl.color,
        lineWidth: 1,
        lineStyle: pl.isSolid ? LineStyle.Solid : LineStyle.SparseDotted,
        title: pl.label || '',
        axisLabelVisible: !!pl.label,
        lineVisible: true,
        axisLabelColor: pl.color,
        axisLabelTextColor: '#ffffff',
      })
    );

    // Order Lines (segments)
    const orderLines = this._priceLines.filter(pl => !!pl.timestamp);
    this.updateSeriesObjects(
      this.chart,
      orderLines,
      this.activeOrderLines,
      (pl, i) => `${pl.price}-${pl.timestamp}-${i}`,
      pl => {
        const originalCandle = allCandles.find((c, i) => {
          const nextCandle = allCandles[i + 1];
          if (nextCandle) return pl.timestamp! >= c.timestamp && pl.timestamp! < nextCandle.timestamp;
          return pl.timestamp! >= c.timestamp && pl.timestamp! < c.timestamp + timeframeSec;
        });
        const startTime = this.timeToLocal(originalCandle ? originalCandle.timestamp : pl.timestamp!);
        const lastCandle = allCandles[allCandles.length - 1];
        const lastTime = lastCandle ? this.timeToLocal(lastCandle.timestamp) : null;
        if (!lastTime || !startTime) return [];
        return [
          { time: startTime, value: pl.price },
          { time: lastTime, value: pl.price }
        ];
      },
      pl => ({
        color: pl.color,
        lineWidth: 1,
        lineStyle: pl.isSolid ? LineStyle.Solid : LineStyle.SparseDotted,
        priceLineVisible: false,
        lastValueVisible: false,
      })
    );

    // Price Labels
    const labels = this._priceLines.filter(pl => pl.isSolid);
    this.updatePriceLineObjects(
      this.mainSeriesApi,
      labels,
      this.activeOrderPriceLabels,
      pl => `label-${pl.price}-${pl.timestamp}`,
      pl => ({
        price: pl.price,
        color: pl.color,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: '',
        lineVisible: false,
        axisLabelColor: pl.color,
        axisLabelTextColor: '#ffffff',
      })
    );
  }

  private updatePriceLineObjects<TData, TKey>(
    seriesApi: ISeriesApi<'Candlestick'> | null,
    dataArray: TData[],
    activeLinesMap: Map<TKey, IPriceLine>,
    getKey: (item: TData) => TKey,
    getOptions: (item: TData) => PriceLineOptions
  ) {
    if (!seriesApi) return;
    const currentKeys = new Set(dataArray.map(getKey));
    activeLinesMap.forEach((line, key) => {
      if (!currentKeys.has(key)) {
        seriesApi.removePriceLine(line);
        activeLinesMap.delete(key);
      }
    });
    dataArray.forEach(item => {
      const key = getKey(item);
      const options = getOptions(item);
      if (!activeLinesMap.has(key)) {
        const line = seriesApi.createPriceLine(options);
        if (line) activeLinesMap.set(key, line);
      } else {
        activeLinesMap.get(key)?.applyOptions(options);
      }
    });
  }

  private updateSeriesObjects<TData, TKey>(
    chartApi: IChartApi | null,
    dataArray: TData[],
    activeSeriesMap: Map<TKey, ISeriesApi<'Line'>>,
    getKey: (item: TData, index: number) => TKey,
    getData: (item: TData) => LineData[],
    getOptions: (item: TData) => any
  ) {
    if (!chartApi) return;
    const currentKeys = new Set(dataArray.map((item, index) => getKey(item, index)));
    activeSeriesMap.forEach((series, key) => {
      if (!currentKeys.has(key)) {
        chartApi.removeSeries(series);
        activeSeriesMap.delete(key);
      }
    });
    dataArray.forEach((item, index) => {
      const key = getKey(item, index);
      const seriesData = getData(item);
      const seriesOptions = getOptions(item);
      if (!activeSeriesMap.has(key)) {
        const lineSeries = chartApi.addSeries(LineSeries, seriesOptions);
        lineSeries.setData(seriesData);
        activeSeriesMap.set(key, lineSeries);
      } else {
        activeSeriesMap.get(key)?.setData(seriesData);
      }
    });
  }

  private updateFibonacci() {
    this.updatePriceLineObjects(
      this.mainSeriesApi,
      this.fibonacciLevels,
      this.activeFibLines,
      fl => fl.title || '',
      fl => fl
    );
    const clearBtn = this.shadowRoot?.getElementById('clear-fib-btn');
    if (clearBtn) clearBtn.style.display = this.fibonacciLevels.length > 0 ? 'inline-block' : 'none';
  }

  private updateTrendlines() {
    this.updateSeriesObjects(
      this.chart,
      this.trendlines,
      this.activeTrendlineSeries,
      (_, i) => i,
      t => [
        { time: t.start.time as UTCTimestamp, value: t.start.price },
        { time: t.end.time as UTCTimestamp, value: t.end.price }
      ],
      () => ({
        color: '#FFFFFF',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
      })
    );
    const clearBtn = this.shadowRoot?.getElementById('clear-trend-btn');
    if (clearBtn) clearBtn.style.display = this.trendlines.length > 0 ? 'inline-block' : 'none';
  }

  private updateHorizontalLines() {
    this.updatePriceLineObjects(
      this.mainSeriesApi,
      this.horizontalLines,
      this.activeHorizontalLines,
      p => p,
      p => ({
        price: p,
        color: '#FFFF00',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: '',
        lineVisible: true,
        axisLabelColor: '#FFFF00',
        axisLabelTextColor: '#000000',
      })
    );
    const clearBtn = this.shadowRoot?.getElementById('clear-hline-btn');
    if (clearBtn) clearBtn.style.display = this.horizontalLines.length > 0 ? 'inline-block' : 'none';
  }

  private handleChartClick(event: MouseEventParams) {
    if (this.isDragging || !this.mainSeriesApi || !event.point || !event.time) {
      this.isDragging = false;
      return;
    }
    const time = event.time as UTCTimestamp;
    const price = this.mainSeriesApi.coordinateToPrice(event.point.y);
    if (!price || !time) return;

    switch (this.activeTool) {
      case 'fibonacci':
        if (!this.fibonacciStartPrice) {
          this.fibonacciStartPrice = price;
        } else {
          this.fibonacciEndPrice = price;
          this.calculateAndDrawFibonacci();
          this.activeTool = null;
          this.fibonacciStartPrice = null;
          this.fibonacciEndPrice = null;
          this.updateToolButtons();
        }
        break;
      case 'trendline':
        if (!this.trendlineStartPoint) {
          this.trendlineStartPoint = { time, price };
        } else {
          const endPrice = this.isShiftPressed ? this.trendlineStartPoint.price : price;
          let start = this.trendlineStartPoint;
          let end = { time, price: endPrice };
          if ((start.time as number) > (end.time as number)) [start, end] = [end, start];
          this.trendlines.push({ start, end });
          this.activeTool = null;
          this.trendlineStartPoint = null;
          this.updateTrendlines();
          this.updateToolButtons();
        }
        break;
      case 'horizontalLine':
        this.horizontalLines.push(price);
        this.updateHorizontalLines();
        this.activeTool = null;
        this.updateToolButtons();
        break;
    }
  }

  private handleCrosshairMove(param: MouseEventParams) {
    if (this.isDragging) return;
    if (!this.mainSeriesApi || !param.point || !param.time) {
      this.currentCursorPrice = null;
      return;
    }
    const time = param.time as UTCTimestamp;
    const price = this.mainSeriesApi.coordinateToPrice(param.point.y);
    if (price === null) return;
    this.currentCursorPrice = price;

    switch (this.activeTool) {
      case 'fibonacci':
        if (this.fibonacciStartPrice) {
          this.fibonacciEndPrice = price;
          this.calculateAndDrawFibonacci();
        }
        break;
      case 'trendline':
        if (this.trendlineStartPoint) {
          const previewEndPrice = this.isShiftPressed ? this.trendlineStartPoint.price : price;
          let p1 = { time: this.trendlineStartPoint.time, value: this.trendlineStartPoint.price };
          let p2 = { time, value: previewEndPrice };
          const data = (p1.time as number) <= (p2.time as number) ? [p1, p2] : [p2, p1];
          if (!this.previewTrendlineSeries) {
            this.previewTrendlineSeries = this.chart?.addSeries(LineSeries, {
              color: '#CCCCCC',
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              priceLineVisible: false,
              lastValueVisible: false,
            }) || null;
          }
          this.previewTrendlineSeries?.setData(data as LineData[]);
        }
        break;
    }
  }

  private handleMouseDown(event: MouseEvent) {
    if (this.activeTool || !this.chart || !this.mainSeriesApi) return;
    const rect = this.chartContainer!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const price = this.mainSeriesApi.coordinateToPrice(y);
    const time = this.chart.timeScale().coordinateToTime(x);
    if (price === null || time === null) return;

    for (let i = 0; i < this.horizontalLines.length; i++) {
      const lineY = this.mainSeriesApi.priceToCoordinate(this.horizontalLines[i]);
      if (lineY !== null && Math.abs(lineY - y) < this.DRAG_THRESHOLD_PX) {
        this.isDragging = true;
        this.draggingLineType = 'horizontal';
        this.draggingLineIndex = i;
        this.chart.applyOptions({ handleScroll: false, handleScale: false });
        event.preventDefault();
        return;
      }
    }

    const timeScale = this.chart.timeScale();
    for (let i = 0; i < this.trendlines.length; i++) {
      const t = this.trendlines[i];
      const sX = timeScale.timeToCoordinate(t.start.time);
      const sY = this.mainSeriesApi.priceToCoordinate(t.start.price);
      const eX = timeScale.timeToCoordinate(t.end.time);
      const eY = this.mainSeriesApi.priceToCoordinate(t.end.price);

      if (sX !== null && sY !== null && Math.sqrt((x - sX) ** 2 + (y - sY) ** 2) < this.DRAG_THRESHOLD_PX) {
        this.isDragging = true;
        this.draggingLineType = 'trendline-point';
        this.draggingLineIndex = i;
        this.draggedTrendlinePoint = 'start';
        this.chart.applyOptions({ handleScroll: false, handleScale: false });
        event.preventDefault();
        return;
      }
      if (eX !== null && eY !== null && Math.sqrt((x - eX) ** 2 + (y - eY) ** 2) < this.DRAG_THRESHOLD_PX) {
        this.isDragging = true;
        this.draggingLineType = 'trendline-point';
        this.draggingLineIndex = i;
        this.draggedTrendlinePoint = 'end';
        this.chart.applyOptions({ handleScroll: false, handleScale: false });
        event.preventDefault();
        return;
      }

      if (sX !== null && sY !== null && eX !== null && eY !== null) {
        if (this.distToSegment({ x, y }, { x: sX, y: sY }, { x: eX, y: eY }) < this.TRENDLINE_BODY_DRAG_THRESHOLD_PX) {
          this.isDragging = true;
          this.draggingLineType = 'trendline-body';
          this.draggingLineIndex = i;
          this.trendlineDragInitialMouseTime = time;
          this.trendlineDragInitialMousePrice = price;
          this.trendlineDragInitialStart = { ...t.start };
          this.trendlineDragInitialEnd = { ...t.end };
          this.chart.applyOptions({ handleScroll: false, handleScale: false });
          event.preventDefault();
          return;
        }
      }
    }
  }

  private handleGlobalMouseMove(event: MouseEvent) {
    if (!this.isDragging || !this.chart || !this.mainSeriesApi) return;
    const rect = this.chartContainer!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const price = this.mainSeriesApi.coordinateToPrice(y);
    const time = this.chart.timeScale().coordinateToTime(x);
    if (price === null || time === null) return;

    if (this.draggingLineType === 'horizontal' && this.draggingLineIndex !== null) {
      this.horizontalLines[this.draggingLineIndex] = price;
      this.updateHorizontalLines();
    } else if (this.draggingLineType === 'trendline-point' && this.draggingLineIndex !== null && this.draggedTrendlinePoint) {
      const t = this.trendlines[this.draggingLineIndex];
      if (this.draggedTrendlinePoint === 'start') t.start = { time: time as UTCTimestamp, price };
      else t.end = { time: time as UTCTimestamp, price };
      if ((t.start.time as number) > (t.end.time as number)) {
        [t.start, t.end] = [t.end, t.start];
        this.draggedTrendlinePoint = this.draggedTrendlinePoint === 'start' ? 'end' : 'start';
      }
      this.updateTrendlines();
    } else if (this.draggingLineType === 'trendline-body' && this.draggingLineIndex !== null && this.trendlineDragInitialMouseTime !== null && this.trendlineDragInitialMousePrice !== null && this.trendlineDragInitialStart && this.trendlineDragInitialEnd) {
      const t = this.trendlines[this.draggingLineIndex];
      const dt = (time as number) - (this.trendlineDragInitialMouseTime as number);
      const dp = price - this.trendlineDragInitialMousePrice;
      t.start = { time: ((this.trendlineDragInitialStart.time as number) + dt) as UTCTimestamp, price: this.trendlineDragInitialStart.price + dp };
      t.end = { time: ((this.trendlineDragInitialEnd.time as number) + dt) as UTCTimestamp, price: this.trendlineDragInitialEnd.price + dp };
      this.updateTrendlines();
    }
  }

  private handleGlobalMouseUp() {
    if (this.isDragging) {
      this.isDragging = false;
      this.draggingLineType = null;
      this.draggingLineIndex = null;
      this.chart?.applyOptions({ handleScroll: true, handleScale: true });
    }
  }

  private activateTool(tool: ActiveTool) {
    if (this.activeTool === tool) this.deactivateCurrentTool();
    else {
      this.deactivateCurrentTool();
      this.activeTool = tool;
    }
    this.updateToolButtons();
  }

  private deactivateCurrentTool() {
    if (this.activeTool === 'fibonacci') {
      this.fibonacciLevels = [];
      this.updateFibonacci();
    } else if (this.activeTool === 'trendline') {
      if (this.previewTrendlineSeries) {
        this.chart?.removeSeries(this.previewTrendlineSeries);
        this.previewTrendlineSeries = null;
      }
    }
    this.activeTool = null;
    this.fibonacciStartPrice = null;
    this.trendlineStartPoint = null;
    this.updateToolButtons();
  }

  private updateToolButtons() {
    if (!this.shadowRoot) return;
    const update = (id: string, active: boolean) => {
      const btn = this.shadowRoot!.getElementById(id);
      if (btn) {
        if (active) btn.setAttribute('selected', '');
        else btn.removeAttribute('selected');
      }
    };
    update('fib-btn', this.activeTool === 'fibonacci');
    update('trend-btn', this.activeTool === 'trendline');
    update('hline-btn', this.activeTool === 'horizontalLine');
  }

  private calculateAndDrawFibonacci() {
    if (this.fibonacciStartPrice === null || this.fibonacciEndPrice === null) return;
    const delta = this.fibonacciEndPrice - this.fibonacciStartPrice;
    this.fibonacciLevels = FIB_LEVELS.map(level => ({
      price: this.fibonacciStartPrice! + delta * level.ratio,
      color: level.color,
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: level.label,
      lineVisible: true,
      axisLabelColor: level.color,
      axisLabelTextColor: ''
    }));
    this.updateFibonacci();
  }

  private clearFibonacci() {
    this.fibonacciLevels = [];
    this.updateFibonacci();
    this.deactivateCurrentTool();
  }

  private clearTrendlines() {
    this.trendlines = [];
    this.updateTrendlines();
    this.deactivateCurrentTool();
  }

  private clearHorizontalLines() {
    this.horizontalLines = [];
    this.updateHorizontalLines();
    this.deactivateCurrentTool();
  }

  private timeToLocal(originalTime: number): UTCTimestamp {
    const d = new Date(originalTime * 1000);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()) / 1000) as UTCTimestamp;
  }

  private calculateEma(data: RawCandlestick[], period: number) {
    const result = [];
    let prevEma = 0;
    for (let i = 0; i < data.length; i++) {
      const candle = data[i];
      const ema = i === 0 ? candle.close : candle.close * (2 / (period + 1)) + prevEma * (1 - 2 / (period + 1));
      prevEma = ema;
      result.push({ time: candle.timestamp, value: ema });
    }
    return result.slice(period * 3);
  }

  private computeMarkColorForBar(d: Date, timeframe: string): string | null {
    const isFirstHourOfWeek = (d: Date) => ((d.getDay() + 6) % 7) === 0 && d.getHours() === 0;
    const barContainsHour = (d: Date, targetHour: number, tf: string) => {
      const h = d.getHours();
      if (tf === '1H') return h === targetHour;
      if (tf === '4H') return h >= Math.floor(targetHour / 4) * 4 && h < Math.floor(targetHour / 4) * 4 + 4;
      if (tf === '1D') return targetHour === 0;
      if (['1S', '10S', '1m', '5m'].includes(tf)) return h === targetHour;
      return false;
    };
    const isFirstDayOfWeek = (d: Date) => ((d.getDay() + 6) % 7) === 0;

    const blueWeekly = 'rgba(33, 150, 243, 0.30)';
    const grayDaily = 'rgba(255, 255, 255, 0.20)';
    const purple4am = 'rgba(156, 39, 176, 0.12)';
    const blue9am = 'rgba(41, 98, 255, 0.12)';
    const green4pm = 'rgba(76, 175, 80, 0.12)';

    if (timeframe !== '1W') {
      if (timeframe === '1D') { if (isFirstDayOfWeek(d)) return blueWeekly; }
      else { if (barContainsHour(d, 0, timeframe) && isFirstHourOfWeek(d)) return blueWeekly; }
    }
    if (timeframe !== '1D' && timeframe !== '1W') { if (barContainsHour(d, 0, timeframe)) return grayDaily; }
    if (['1S', '10S', '1m', '5m', '1H'].includes(timeframe)) {
      const h = d.getHours();
      if (h === 4) return purple4am;
      if (h === 9) return blue9am;
      if (h === 16) return green4pm;
    }
    return null;
  }

  private distToSegment(p: { x: number, y: number }, v: { x: number, y: number }, w: { x: number, y: number }) {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt((p.x - (v.x + t * (w.x - v.x))) ** 2 + (p.y - (v.y + t * (w.y - v.y))) ** 2);
  }
}
