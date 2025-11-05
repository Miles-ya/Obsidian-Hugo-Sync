import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, TAbstractFile } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { languages, LanguageStrings } from './lang';

interface HugoSyncSettings {
  hugoPath: string;
  contentPath: string;
  filteredHeaders: string[];
  language: string;
}

const DEFAULT_SETTINGS: HugoSyncSettings = {
  hugoPath: '',
  contentPath: 'content/posts',
  filteredHeaders: [],
  language: 'en'
}

export default class HugoSyncPlugin extends Plugin {
  settings: HugoSyncSettings;
  lang: LanguageStrings;

  async onload() {
    await this.loadSettings();
    this.lang = languages[this.settings.language] || languages.en;

    try {
      // Change the icon to 'refresh-cw'
      this.addRibbonIcon('refresh-cw', 'Sync to Hugo', (evt: MouseEvent) => {
        this.syncSelectedToHugo();
      });
    } catch (error) {
      console.error('Failed to add ribbon icon:', error);
    }

    this.addCommand({
      id: 'sync-selected-to-hugo',
      name: 'Sync selected file(s) to Hugo',
      callback: () => this.syncSelectedToHugo(),
    });

    this.addSettingTab(new HugoSyncSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.lang = languages[this.settings.language] || languages.en;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.lang = languages[this.settings.language] || languages.en;
  }

  async syncSelectedToHugo() {
    const selectedFiles = this.getSelectedFiles();
    if (selectedFiles.length === 0) {
      new Notice(this.lang.notices.noFilesSelected);
      return;
    }

    let successCount = 0;
    let failCount = 0;
    let errorMessages = [];

    for (const file of selectedFiles) {
      try {
        await this.syncFileToHugo(file);
        successCount++;
      } catch (error) {
        failCount++;
        errorMessages.push(`${file.name}: ${error.message}`);
        console.error(`Error syncing file ${file.name}:`, error);
      }
    }

    // 创建详细的结果消息
    let resultMessage = this.lang.notices.syncResult
      .replace('{0}', selectedFiles.length.toString())
      .replace('{1}', successCount.toString())
      .replace('{2}', failCount.toString());

    if (failCount > 0) {
      resultMessage += '\n\n' + this.lang.notices.syncErrors + ':\n' + errorMessages.join('\n');
    }

    // 显示结果通知
    new Notice(resultMessage, 10000);  // 显示10秒

    // 如果有错误，在控制台输出详细信息
    if (failCount > 0) {
      console.error('Sync errors:', errorMessages);
    }
  }

  getSelectedFiles(): TFile[] {
    const selectedFiles: TFile[] = [];
    
    // 获取文浏览器中选中的文件
    const fileExplorer = this.app.workspace.getLeavesOfType('file-explorer')[0];
    if (fileExplorer && fileExplorer.view) {
      // @ts-ignore
      const selectedItems = fileExplorer.view.fileItems;
      if (selectedItems) {
        for (const item of Object.values(selectedItems)) {
          // @ts-ignore
          if (item && item.file instanceof TFile && item.titleEl && item.titleEl.classList && item.titleEl.classList.contains('is-selected')) {
            selectedFiles.push(item.file);
          }
        }
      }
    }

    // 如果文件浏览器中没有选中文件，则使用当前活动文件
    if (selectedFiles.length === 0) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        selectedFiles.push(activeFile);
      }
    }

    return selectedFiles;
  }

  async syncFileToHugo(file: TFile) {
    const content = await this.app.vault.read(file);

    const hugoContent = this.convertToHugoFormat(content, file.name);

    const hugoDirPath = path.join(this.settings.hugoPath, this.settings.contentPath);
    const hugoFilePath = path.join(hugoDirPath, file.name);

    // 确保目录存在
    if (!fs.existsSync(hugoDirPath)) {
      fs.mkdirSync(hugoDirPath, { recursive: true });
    }

    fs.writeFileSync(hugoFilePath, hugoContent);
  }

  convertToHugoFormat(content: string, fileName: string): string {
    // 检测是否存在 YAML 前置元数据
    const hasExistingYaml = content.startsWith('---') &&
                           content.indexOf('---', 3) > 3;

    if (hasExistingYaml) {
      return this.adjustExistingYaml(content, fileName);
    } else {
      return this.createNewYaml(content, fileName);
    }
  }

  adjustExistingYaml(content: string, fileName: string): string {
    const title = fileName.replace('.md', '');
    const date = new Date().toISOString();
    const tags: string[] = [];

    // 提取现有 YAML 块（不包含结尾的 ---）
    const firstYamlEnd = content.indexOf('---', 3);
    const existingYaml = content.substring(0, firstYamlEnd);
    const contentAfterYaml = content.substring(firstYamlEnd).trim();

    // 解析现有 YAML 中的标签
    const lines = existingYaml.split('\n');
    let inTagsSection = false;

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine === 'tags:') {
        inTagsSection = true;
        continue;
      }

      if (inTagsSection) {
        if (trimmedLine.startsWith('-')) {
          const tag = trimmedLine.slice(1).trim().replace(/['"]/g, '');
          if (tag && !tags.includes(tag)) {
            tags.push(tag);
          }
        } else if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
          // 处理数组格式 tags: ["tag1", "tag2"]
          const tagArray = trimmedLine.slice(1, -1).split(',');
          for (const tag of tagArray) {
            const cleanTag = tag.trim().replace(/['"]/g, '');
            if (cleanTag && !tags.includes(cleanTag)) {
              tags.push(cleanTag);
            }
          }
        } else if (trimmedLine && !trimmedLine.startsWith(' ') && !trimmedLine.startsWith('\t')) {
          // 遇到新的字段，结束标签解析
          inTagsSection = false;
        }
      }
    }

    // 处理内容中的内联标签和标题过滤
    const processedContent = this.processContentWithTagsAndFiltering(contentAfterYaml, tags);

    // 解析现有 YAML，添加缺失字段
    const adjustedYaml = this.adjustYamlFields(existingYaml, title, date, tags);

    return adjustedYaml + '\n\n' + processedContent.join('\n').trim();
  }

  createNewYaml(content: string, fileName: string): string {
    const title = fileName.replace('.md', '');
    const date = new Date().toISOString();
    const tags: string[] = [];

    const processedContent = this.processContentWithTagsAndFiltering(content, tags);

    // 创建 Hugo 格式的前置元数据
    const hugoFrontMatter = `---
title: "${title}"
date: ${date}
draft: false
tags: [${tags.map(tag => `"${tag}"`).join(', ')}]
---

`;

    return hugoFrontMatter + processedContent.join('\n').trim();
  }

  processContentWithTagsAndFiltering(content: string, tags: string[]): string[] {
    const lines = content.split('\n');
    let tagSection = false;
    let processedContent = [];
    let currentHeaderLevel = 0;
    let skipContent = false;

    const symbolOnlyRegex = /^[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]+$/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('#')) {
        const headerMatch = trimmedLine.match(/^(#+)\s*(.*)/);
        if (headerMatch) {
          const headerLevel = headerMatch[1].length;
          const headerContent = headerMatch[2];

          if (headerLevel <= currentHeaderLevel) {
            skipContent = false;
          }

          if (this.settings.filteredHeaders.includes(headerContent)) {
            skipContent = true;
            currentHeaderLevel = headerLevel;
            continue;
          }

          currentHeaderLevel = headerLevel;
        }
      }

      if (trimmedLine === 'tags:') {
        tagSection = true;
        continue;
      }

      if (tagSection) {
        if (trimmedLine.startsWith('-')) {
          const tag = trimmedLine.slice(1).trim();
          if (tag && !symbolOnlyRegex.test(tag) && !tags.includes(tag)) {
            tags.push(tag);
          }
        } else {
          tagSection = false;
        }
      } else if (!skipContent) {
        // 处理内联标签
        const standaloneTagsMatch = trimmedLine.match(/#[^\s#]+/g);
        if (standaloneTagsMatch) {
          standaloneTagsMatch.forEach(tag => {
            const cleanTag = tag.slice(1); // Remove the '#'
            if (!symbolOnlyRegex.test(cleanTag) && !tags.includes(cleanTag)) {
              tags.push(cleanTag);
            }
          });
          // 移除内联标签
          const cleanedLine = line.replace(/#[^\s#]+/g, '').trim();
          if (cleanedLine) {
            processedContent.push(cleanedLine);
          }
        } else {
          processedContent.push(line); // Keep original indentation
        }
      }
    }

    return processedContent;
  }

  adjustYamlFields(existingYaml: string, title: string, date: string, tags: string[]): string {
    const lines = existingYaml.split('\n');
    const result: string[] = [];
    let hasTitle = false;
    let hasDate = false;
    let hasDraft = false;
    let hasTags = false;

    // 解析现有字段（跳过开头的 ---）
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // 跳过开头的 ---
      if (trimmedLine === '---' && i === 0) {
        result.push(line);
        continue;
      }

      if (trimmedLine.startsWith('title:')) {
        hasTitle = true;
        result.push(line);
      } else if (trimmedLine.startsWith('date:')) {
        hasDate = true;
        result.push(line);
      } else if (trimmedLine.startsWith('draft:')) {
        hasDraft = true;
        result.push(line);
      } else if (trimmedLine.startsWith('tags:')) {
        hasTags = true;
        // 处理现有标签并合并新标签
        result.push(this.mergeTagsLine(line, tags));
        i = lines.length - 1; // 跳过原有标签的其他行
      } else if (trimmedLine.startsWith('-')) {
        // 跳过原有标签的其他行
        if (hasTags) continue;
        result.push(line);
      } else {
        result.push(line);
      }
    }

    // 添加缺失的字段
    if (!hasTitle) result.push(`title: "${title}"`);
    if (!hasDate) result.push(`date: ${date}`);
    if (!hasDraft) result.push('draft: false');
    if (!hasTags) result.push(`tags: [${tags.map(tag => `"${tag}"`).join(', ')}]`);

    // 添加结尾的 ---
    result.push('---');

    return result.join('\n');
  }

  mergeTagsLine(existingTagsLine: string, newTags: string[]): string {
    // 解析现有标签
    const existingTags: string[] = [];
    const trimmedLine = existingTagsLine.trim();

    if (trimmedLine === 'tags:') {
      // 格式: tags:，需要读取后续行
      return `tags: [${newTags.map(tag => `"${tag}"`).join(', ')}]`;
    } else if (trimmedLine.startsWith('tags: [') && trimmedLine.endsWith(']')) {
      // 格式: tags: ["tag1", "tag2"]
      const tagContent = trimmedLine.slice(7, -1);
      const tagArray = tagContent.split(',');
      for (const tag of tagArray) {
        const cleanTag = tag.trim().replace(/['"]/g, '');
        if (cleanTag && !existingTags.includes(cleanTag)) {
          existingTags.push(cleanTag);
        }
      }
    }

    // 合并新旧标签
    const allTags = [...new Set([...existingTags, ...newTags])];
    return `tags: [${allTags.map(tag => `"${tag}"`).join(', ')}]`;
  }
}

class HugoSyncSettingTab extends PluginSettingTab {
  plugin: HugoSyncPlugin;

  constructor(app: App, plugin: HugoSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;
    containerEl.empty();
    containerEl.createEl('h2', {text: this.plugin.lang.settings.pluginName});

    new Setting(containerEl)
      .setName(this.plugin.lang.settings.hugoPath)
      .setDesc(this.plugin.lang.settings.hugoPathDesc)
      .addText(text => text
        .setPlaceholder('Enter path')
        .setValue(this.plugin.settings.hugoPath)
        .onChange(async (value) => {
          this.plugin.settings.hugoPath = value;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName(this.plugin.lang.settings.contentPath)
      .setDesc(this.plugin.lang.settings.contentPathDesc)
      .addText(text => text
        .setPlaceholder('content/posts')
        .setValue(this.plugin.settings.contentPath)
        .onChange(async (value) => {
          this.plugin.settings.contentPath = value;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName(this.plugin.lang.settings.filteredHeaders)
      .setDesc(this.plugin.lang.settings.filteredHeadersDesc)
      .addTextArea(text => text
        .setPlaceholder('Enter headers here\nOne per line')
        .setValue(this.plugin.settings.filteredHeaders.join('\n'))
        .onChange(async (value) => {
          this.plugin.settings.filteredHeaders = value.split('\n').map(s => s.trim()).filter(s => s);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Language')
      .setDesc('Select plugin language')
      .addDropdown(dropdown => dropdown
        .addOptions({ 'en': 'English', 'zh': '中文' })
        .setValue(this.plugin.settings.language)
        .onChange(async (value) => {
          this.plugin.settings.language = value;
          await this.plugin.saveSettings();
          this.display(); // 重新加载设置页面以应用新语言
        }));
  }
}