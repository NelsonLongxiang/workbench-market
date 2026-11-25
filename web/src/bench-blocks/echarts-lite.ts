/**
 * 图表库只装用到的几样（柱、线、饼、关系图（任务图）、自定义系列（甘特图）、坐标系、提示、图例、标线与数据缩放（甘特图的今天线和纵向滚动）、画布渲染），整份按需加载成单独的块：
 * 没有图表的页面不下载它，它也不进首屏的包（vite.config.ts 里把它排除在 vendor 之外）。
 */
import * as echarts from 'echarts/core';
import { BarChart, CustomChart, GraphChart, LineChart, PieChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, CustomChart, GraphChart, LineChart, PieChart, DataZoomComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);
export default echarts;
