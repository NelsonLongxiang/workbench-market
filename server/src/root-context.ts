/**
 * 根上下文：全进程唯一的 Cordis Context。
 *
 * 单独成文件，是因为取用它不能带出别的事：context.ts 一被引用就打开数据库，
 * 而登录门、SOP 字段通道这类不碰库的模块（和它们的单测）也要取上下文里的服务。
 * 这里只建上下文，不装任何东西；谁提供服务，谁自己装。
 */
import { Context } from '@deepseek-ai/cordis';

export const root = new Context();
