/**
 * 图表库只装用到的几样（柱、线、饼、坐标系、提示、图例、画布渲染），整份按需加载成单独的块：
 * 没有图表的页面不下载它，它也不进首屏的包（vite.config.ts 里把它排除在 vendor 之外）。
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);
export default echarts;
