import { App, Plugin, PluginSettingTab, Setting, Editor, Notice, Modal, ToggleComponent } from 'obsidian';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

type HighlightStyle = 'background' | 'underline';
type ToggleScope = 'all' | 'paragraphs' | 'headers';

interface HighlightProfile {
    color: string;
    opacity: number;
    useCustomTextColor: boolean;
    textColor: string;
}

interface Highlighter {
    id: string;
    styleType: HighlightStyle;
    borderRadius: number;
    isToggleable: boolean;
    toggleScope: ToggleScope;
    light: HighlightProfile;
    dark: HighlightProfile;
}

interface HPPlusSettings {
    highlighters: Highlighter[];
}

const defaultColors = ['#8f3d3d', '#8f7a3d', '#668f3d', '#3d8f52', '#3d8f8f', '#3d528f', '#663d8f', '#8f3d7a'];
const DEFAULT_HIGHLIGHTERS: Highlighter[] = defaultColors.map((color, index) => {
    return { 
        id: (index + 1).toString(), 
        styleType: 'background',
        borderRadius: 3,
        isToggleable: true,
        toggleScope: 'all',
        light: { color, opacity: 0.5, useCustomTextColor: true, textColor: '#fafafa' }, 
        dark: { color, opacity: 0.5, useCustomTextColor: false, textColor: '#ffffff' } 
    };
});

const DEFAULT_SETTINGS: HPPlusSettings = { highlighters: [...DEFAULT_HIGHLIGHTERS] };

const forceUpdateEffect = StateEffect.define<null>();

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hslToHex(h: number, s: number, l: number): string {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

export default class HighlighterPlus extends Plugin {
    settings: HPPlusSettings;
    ghostIds: Set<string> = new Set(); 

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new HPSettingTab(this.app, this));
        this.injectGlobalStyles();

        this.addCommand({
            id: 'hp-toggle-cycle',
            name: 'Toggle Highlighter Cycle',
            editorCallback: (editor) => this.cycleHighlights(editor)
        });

        this.addCommand({
            id: 'hp-remove',
            name: 'Remove Highlighter',
            editorCallback: (editor) => this.removeHighlight(editor)
        });

        this.registerEditorExtension(this.buildLivePreviewPlugin());
        this.registerMarkdownPostProcessor((el) => this.processReadingMode(el));
    }

    onunload() {
        document.getElementById('hp-styles')?.remove();
        document.getElementById('hp-settings-layout-css')?.remove();
    }

    injectGlobalStyles() {
        const styleId = 'hp-styles';
        let styleEl = document.getElementById(styleId);
        if (!styleEl) { 
            styleEl = document.head.createEl('style'); 
            styleEl.id = styleId;
        }
        
        let css = `
            .hp-base { padding: 0 2px; text-decoration: none !important; }
            
            /* TWARDY RESET - MORDUJE DOMYŚLNE TŁO OBSIDIANA */
            body .markdown-source-view.mod-cm6 .cm-line .cm-highlight.hp-base,
            body .markdown-source-view.mod-cm6 .cm-line .cm-highlight:has(.hp-base),
            body .markdown-source-view.mod-cm6 .cm-line .cm-formatting-highlight.hp-base,
            body .markdown-source-view.mod-cm6 .cm-line .cm-formatting-highlight:has(.hp-base),
            body .markdown-preview-view mark.hp-base,
            body .markdown-preview-view mark:has(.hp-base) {
                background-color: transparent !important;
                background-image: none !important;
                background: transparent !important;
                box-shadow: none !important;
                border: none !important;
                border-bottom: none !important;
                text-decoration: none !important;
                color: inherit !important;
                -webkit-text-fill-color: inherit !important;
                --text-highlight-bg: transparent !important;
            }

            /* UKRYWANIE ELEMENTÓW SYNTAXU */
            body .markdown-source-view.mod-cm6 .hp-hide {
                display: none !important;
            }

            /* ZABICIE EWENTUALNYCH NAROŚLI Z INNYCH MOTYWÓW */
            body .markdown-source-view.mod-cm6 .cm-line .cm-highlight:has(.hp-base)::before,
            body .markdown-source-view.mod-cm6 .cm-line .cm-highlight:has(.hp-base)::after,
            body .markdown-preview-view mark:has(.hp-base)::before,
            body .markdown-preview-view mark:has(.hp-base)::after {
                display: none !important;
                content: none !important;
                background: transparent !important;
            }

            /* MORDERCA WEWNĘTRZNY DLA USUNIĘTYCH ZAKREŚLACZY */
            body .markdown-source-view.mod-cm6 .hp-base,
            body .markdown-preview-view .hp-base {
                background-color: transparent !important;
                background-image: none !important;
                background: transparent !important;
                box-shadow: none !important;
                border: none !important;
                border-bottom: none !important;
                text-decoration: none !important;
                color: inherit !important;
                -webkit-text-fill-color: inherit !important;
            }
        \n`;
        
        this.settings.highlighters.forEach(hl => {
            const generateRule = (profile: HighlightProfile, themeClass: string) => {
                const rgbaColor = hexToRgba(profile.color, profile.opacity);
                const textStyle = profile.useCustomTextColor 
                    ? `color: ${profile.textColor} !important; -webkit-text-fill-color: ${profile.textColor} !important;` 
                    : `color: inherit !important; -webkit-text-fill-color: inherit !important;`;
                const radiusStyle = `border-radius: ${hl.borderRadius}px !important;`;

                const selectors = `
                    body.${themeClass} .markdown-source-view.mod-cm6 .cm-line .cm-highlight:has(.hp-base.hp-${hl.id}), 
                    body.${themeClass} .markdown-source-view.mod-cm6 .hp-base.hp-${hl.id},
                    body.${themeClass} .markdown-preview-view mark:has(.hp-base.hp-${hl.id}),
                    body.${themeClass} .markdown-preview-view .hp-base.hp-${hl.id}
                `;

                if (hl.styleType === 'underline') {
                    css += `${selectors} { 
                        background-color: transparent !important; 
                        background: transparent !important; 
                        background-image: none !important; 
                        box-shadow: none !important; 
                        border-bottom: 3px solid ${rgbaColor} !important; 
                        --text-highlight-bg: transparent !important;
                        ${radiusStyle}
                        ${textStyle} 
                    }\n`;
                } else {
                    css += `${selectors} { 
                        background-color: ${rgbaColor} !important; 
                        background: ${rgbaColor} !important; 
                        background-image: none !important; 
                        box-shadow: none !important; 
                        border-bottom: none !important; 
                        --text-highlight-bg: ${rgbaColor} !important;
                        ${radiusStyle}
                        ${textStyle} 
                    }\n`;
                }
            };

            generateRule(hl.light, 'theme-light');
            generateRule(hl.dark, 'theme-dark');
        });
        styleEl.textContent = css;
    }

    buildLivePreviewPlugin() {
        return ViewPlugin.fromClass(class {
            decorations: DecorationSet;
            constructor(view: EditorView) { this.decorations = this.buildDeco(view); }
            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged || update.selectionSet || 
                    update.transactions.some(tr => tr.effects.some(e => e.is(forceUpdateEffect)))) {
                    this.decorations = this.buildDeco(update.view);
                }
            }
            buildDeco(view: EditorView) {
                const builder = new RangeSetBuilder<Decoration>();
                const text = view.state.doc.toString();
                const regex = /==([a-zA-Z0-9_-]+)=(.*?)==/g;
                const selection = view.state.selection.main;
                let match;

                while ((match = regex.exec(text)) !== null) {
                    const [full, id] = match;
                    const start = match.index;
                    const end = start + full.length;
                    const isInside = selection.from <= end && selection.to >= start;

                    if (isInside) {
                        builder.add(start, end, Decoration.mark({ class: `hp-base hp-${id}` }));
                    } else {
                        const idLen = id.length + 3;
                        builder.add(start, start + idLen, Decoration.mark({ class: "hp-hide" }));
                        builder.add(start + idLen, end - 2, Decoration.mark({ class: `hp-base hp-${id}` }));
                        builder.add(end - 2, end, Decoration.mark({ class: "hp-hide" }));
                    }
                }
                return builder.finish();
            }
        }, { decorations: v => v.decorations });
    }

    processReadingMode(element: HTMLElement) {
        element.querySelectorAll("mark").forEach((markEl: HTMLElement) => {
            const match = markEl.innerHTML.trim().match(/^([a-zA-Z0-9_-]+)=([\s\S]*)$/);
            if (match) {
                const id = match[1];
                const content = match[2];
                markEl.className = `hp-base hp-${id}`;
                markEl.innerHTML = content;
            }
        });
        
        const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
        const nodes: Node[] = [];
        let n;
        while(n = walk.nextNode()) nodes.push(n);
        
        const fallbackRegex = /==([a-zA-Z0-9_-]+)=([\s\S]*?)==/g;
        
        nodes.forEach(node => {
            if (node.parentElement && node.parentElement.closest('code, pre, .hp-base')) return;
            
            const text = node.nodeValue || '';
            if (text.includes('==') && fallbackRegex.test(text)) {
                const frag = document.createDocumentFragment();
                let lastIdx = 0;
                fallbackRegex.lastIndex = 0;
                let match;
                
                while ((match = fallbackRegex.exec(text)) !== null) {
                    if (match.index > lastIdx) {
                        frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
                    }
                    
                    const span = document.createElement('span');
                    span.className = `hp-base hp-${match[1]}`;
                    span.textContent = match[2];
                    frag.appendChild(span);
                    
                    lastIdx = fallbackRegex.lastIndex;
                }
                
                if (lastIdx < text.length) {
                    frag.appendChild(document.createTextNode(text.slice(lastIdx)));
                }
                
                node.parentNode?.replaceChild(frag, node);
            }
        });
    }

    findHighlightAtCursor(editor: Editor) {
        const selStart = editor.posToOffset(editor.getCursor('from'));
        const selEnd = editor.posToOffset(editor.getCursor('to'));
        const text = editor.getValue();
        
        const regex = /==([a-zA-Z0-9_-]+)=([\s\S]*?)==/g;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const startOffset = match.index;
            const endOffset = startOffset + match[0].length;
            
            if (selStart >= startOffset && selEnd <= endOffset) {
                return {
                    id: match[1],
                    content: match[2],
                    start: editor.offsetToPos(startOffset),
                    end: editor.offsetToPos(endOffset)
                };
            }
        }
        return null;
    }

    cycleHighlights(editor: Editor) {
        const cursor = editor.getCursor();
        const lineText = editor.getLine(cursor.line);
        const isHeader = /^#{1,6}\s/.test(lineText);

        const tgl = this.settings.highlighters.filter(h => {
            if (!h.isToggleable) return false;
            if (h.toggleScope === 'headers' && !isHeader) return false;
            if (h.toggleScope === 'paragraphs' && isHeader) return false;
            return true;
        });

        if (tgl.length === 0) {
            new Notice("No active highlighters for this context.");
            return;
        }

        const activeHighlight = this.findHighlightAtCursor(editor);

        if (activeHighlight) {
            const currIdx = tgl.findIndex(h => h.id === activeHighlight.id);
            let newText = "";
            let newPrefixLen = 0;

            if (currIdx === -1 || currIdx === tgl.length - 1) {
                newText = activeHighlight.content;
                newPrefixLen = 0;
            } else {
                const nextId = tgl[currIdx + 1].id;
                newText = `==${nextId}=${activeHighlight.content}==`;
                newPrefixLen = nextId.length + 3;
            }

            editor.replaceRange(newText, activeHighlight.start, activeHighlight.end);
            
            const startOffset = editor.posToOffset(activeHighlight.start);
            editor.setSelection(
                editor.offsetToPos(startOffset + newPrefixLen),
                editor.offsetToPos(startOffset + newPrefixLen + activeHighlight.content.length)
            );
            return;
        }

        const sel = editor.getSelection();

        if (sel) {
            const cleanSel = sel.replace(/==[a-zA-Z0-9_-]+=/g, "").replace(/==/g, "");
            const start = editor.getCursor('from');
            const end = editor.getCursor('to');
            const firstId = tgl[0].id;
            const prefix = `==${firstId}=`;
            
            editor.replaceRange(`${prefix}${cleanSel}==`, start, end);
            
            const startOffset = editor.posToOffset(start);
            editor.setSelection(
                editor.offsetToPos(startOffset + prefix.length),
                editor.offsetToPos(startOffset + prefix.length + cleanSel.length)
            );
        } else {
            const firstId = tgl[0].id;
            const prefixDelta = firstId.length + 3;
            const cursor = editor.getCursor();
            const line = editor.getLine(cursor.line);
            let left = cursor.ch;
            let right = cursor.ch;

            while (left > 0 && /[\p{L}\p{N}_]/u.test(line[left - 1])) { left--; }
            while (right < line.length && /[\p{L}\p{N}_]/u.test(line[right])) { right++; }

            if (left < right) {
                const word = line.slice(left, right);
                editor.replaceRange(`==${firstId}=${word}==`, {line: cursor.line, ch: left}, {line: cursor.line, ch: right});
                editor.setSelection(
                    {line: cursor.line, ch: left + prefixDelta},
                    {line: cursor.line, ch: left + prefixDelta + word.length}
                );
            }
        }
    }

    removeHighlight(editor: Editor) {
        const activeHighlight = this.findHighlightAtCursor(editor);
        if (activeHighlight) {
            editor.replaceRange(activeHighlight.content, activeHighlight.start, activeHighlight.end);
            const startOffset = editor.posToOffset(activeHighlight.start);
            editor.setSelection(
                editor.offsetToPos(startOffset),
                editor.offsetToPos(startOffset + activeHighlight.content.length)
            );
        } else {
            const sel = editor.getSelection();
            if (sel) {
                const cleanSel = sel.replace(/==[a-zA-Z0-9_-]+=/g, "").replace(/==/g, "");
                const start = editor.getCursor('from');
                const end = editor.getCursor('to');
                editor.replaceRange(cleanSel, start, end);
                const startOffset = editor.posToOffset(start);
                editor.setSelection(
                    editor.offsetToPos(startOffset),
                    editor.offsetToPos(startOffset + cleanSel.length)
                );
            }
        }
    }

    async loadSettings() { 
        const data = await this.loadData();
        if (data && data.highlighters) {
            data.highlighters = data.highlighters.map((hl: any) => {
                let migratedStyleType = hl.styleType || (hl.light && hl.light.styleType) || 'background';
                
                if (!hl.light) {
                    const prof = {
                        color: hl.color || '#8f3d3d', opacity: hl.opacity !== undefined ? hl.opacity : 0.5,
                        useCustomTextColor: hl.useCustomTextColor || false, textColor: hl.textColor || '#ffffff'
                    };
                    return { id: hl.id, styleType: migratedStyleType, borderRadius: hl.borderRadius !== undefined ? hl.borderRadius : 3, isToggleable: hl.isToggleable !== undefined ? hl.isToggleable : true, toggleScope: hl.toggleScope || 'all', light: { ...prof }, dark: { ...prof } };
                }
                
                if (hl.light && hl.light.styleType) delete hl.light.styleType;
                if (hl.dark && hl.dark.styleType) delete hl.dark.styleType;
                
                if (hl.borderRadius === undefined) hl.borderRadius = 3;
                if (hl.styleType === undefined) hl.styleType = migratedStyleType;
                if (hl.toggleScope === undefined) hl.toggleScope = 'all';
                
                return hl;
            });
        }
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data); 
    }
    
    async saveSettings() { 
        await this.saveData(this.settings); 
        this.injectGlobalStyles(); 
        
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() === 'markdown') {
                const view = leaf.view as any;
                if (view.previewMode) {
                    view.previewMode.rerender(true);
                }
                const editor = view.editor;
                if (editor && editor.cm) {
                    editor.cm.dispatch({
                        effects: forceUpdateEffect.of(null)
                    });
                }
            }
        });
    }
}

class DeleteConfirmModal extends Modal {
    onConfirm: () => void;
    hlId: string;

    constructor(app: App, hlId: string, onConfirm: () => void) { 
        super(app); 
        this.hlId = hlId;
        this.onConfirm = onConfirm; 
    }
    
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Delete Highlighter' });
        contentEl.createEl('p', { text: `Are you sure you want to delete highlighter "${this.hlId}"?` });
        new Setting(contentEl)
            .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
            .addButton(b => b.setButtonText('Delete').setWarning().onClick(() => { this.onConfirm(); this.close(); }));
        
        this.scope.register([], 'Enter', (e) => {
            e.preventDefault();
            this.onConfirm();
            this.close();
        });
    }
    onClose() { this.contentEl.empty(); }
}

class RestoreDefaultsModal extends Modal {
    onConfirm: () => void;
    constructor(app: App, onConfirm: () => void) { super(app); this.onConfirm = onConfirm; }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Restore Defaults' });
        contentEl.createEl('p', { text: 'Are you sure you want to restore default settings? Your current highlighters will be permanently deleted.' });
        new Setting(contentEl)
            .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
            .addButton(b => b.setButtonText('Restore').setWarning().onClick(() => { this.onConfirm(); this.close(); }));
        
        this.scope.register([], 'Enter', (e) => {
            e.preventDefault();
            this.onConfirm();
            this.close();
        });
    }
    onClose() { this.contentEl.empty(); }
}

class HPSettingTab extends PluginSettingTab {
    plugin: HighlighterPlus;
    highlightIdToFlash: string | null = null; 

    constructor(app: App, plugin: HighlighterPlus) { super(app, plugin); this.plugin = plugin; }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Highlighter Plus' });

        const helpBox = containerEl.createDiv({ cls: 'hp-help-box' });
        helpBox.innerHTML = `
            <strong>Instructions:</strong>
            <ul>
                <li><strong>Name:</strong> Short identifier. Use in text like: <code>==name=your text==</code></li>
                <li><strong>Type:</strong> <em>Highlight</em> paints the background, <em>Underline</em> creates a discreet colorful line.</li>
                <li><strong>Toggle via hotkey:</strong> Select a word and press the plugin's hotkey. The style will cycle to the next active one.</li>
            </ul>
        `;

        const listContainer = containerEl.createDiv({ cls: 'hp-settings-list' });
        const isAppDarkMode = document.body.classList.contains('theme-dark');
        
        const flashId = this.highlightIdToFlash;
        this.highlightIdToFlash = null; 

        this.plugin.settings.highlighters.forEach((hl, idx) => {
            const card = listContainer.createDiv({ cls: 'hp-hl-card' });
            
            if (hl.id === flashId) {
                card.addClass('hp-hl-card-flash');
                setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
            }
            
            const header = card.createDiv({ cls: 'hp-hl-header' });

            const gridCont = header.createDiv({ cls: 'hp-hl-grid' });
            
            const labelsRow = gridCont.createDiv({ cls: 'hp-hl-labels' });
            labelsRow.createDiv({ text: 'Name', cls: 'hp-hl-label' });
            labelsRow.createDiv({ text: 'Type', cls: 'hp-hl-label' });
            const radLabel = labelsRow.createDiv({ cls: 'hp-hl-label' });
            radLabel.innerHTML = `Corner Radius <span class="hp-rad-val">(${hl.borderRadius}px)</span>`;
            labelsRow.createDiv({ text: 'Toggle via hotkey', cls: 'hp-hl-label' });

            const controlsRow = gridCont.createDiv({ cls: 'hp-hl-controls' });
            
            const idInp = controlsRow.createEl('input', { attr: { type: 'text', value: hl.id, title: 'Highlighter Name' }});
            idInp.onchange = async () => {
                const cleanVal = idInp.value.trim();
                if (this.plugin.settings.highlighters.some((h, i) => h.id === cleanVal && i !== idx)) {
                    new Notice("This name is already taken!");
                    idInp.value = hl.id; return;
                }
                this.plugin.ghostIds.add(hl.id);
                hl.id = cleanVal; 
                await this.plugin.saveSettings(); 
                this.display();
            };

            const typeSel = controlsRow.createEl('select');
            typeSel.createEl('option', { value: 'background', text: 'Highlight' }).selected = hl.styleType === 'background';
            typeSel.createEl('option', { value: 'underline', text: 'Underline' }).selected = hl.styleType === 'underline';
            typeSel.onchange = async () => { 
                hl.styleType = typeSel.value as HighlightStyle; 
                await this.plugin.saveSettings(); 
                this.display(); 
            };

            const radInp = controlsRow.createEl('input', { attr: { type: 'range', min: '0', max: '10', step: '1', value: hl.borderRadius.toString() }});
            radInp.oninput = () => { radLabel.querySelector('.hp-rad-val')!.textContent = `(${radInp.value}px)`; };
            radInp.onchange = async () => {
                hl.borderRadius = parseInt(radInp.value) || 0; 
                await this.plugin.saveSettings(); 
                this.display();
            };

            const tglWrapper = controlsRow.createDiv({ cls: 'hp-hl-tgl-wrapper' });
            const tglComp = new ToggleComponent(tglWrapper).setValue(hl.isToggleable);
            
            const scopeSel = tglWrapper.createEl('select', { cls: 'hp-scope-sel' });
            scopeSel.createEl('option', { value: 'all', text: 'All texts' }).selected = hl.toggleScope === 'all';
            scopeSel.createEl('option', { value: 'paragraphs', text: 'Only paragraphs' }).selected = hl.toggleScope === 'paragraphs';
            scopeSel.createEl('option', { value: 'headers', text: 'Only headers' }).selected = hl.toggleScope === 'headers';
            
            scopeSel.style.display = hl.isToggleable ? 'block' : 'none';

            scopeSel.onchange = async () => {
                hl.toggleScope = scopeSel.value as ToggleScope;
                await this.plugin.saveSettings();
            };

            tglComp.onChange(async v => { 
                hl.isToggleable = v; 
                scopeSel.style.display = v ? 'block' : 'none';
                await this.plugin.saveSettings(); 
            });
            
            const actionsWrapper = header.createDiv({ cls: 'hp-hl-actions-wrapper' });

            const upBtn = actionsWrapper.createEl('button', { text: '↑', cls: 'hp-hl-action-btn', attr: { title: 'Move Up' } });
            if (idx === 0) upBtn.disabled = true;
            else {
                upBtn.onclick = async () => {
                    const temp = this.plugin.settings.highlighters[idx - 1];
                    this.plugin.settings.highlighters[idx - 1] = this.plugin.settings.highlighters[idx];
                    this.plugin.settings.highlighters[idx] = temp;
                    await this.plugin.saveSettings();
                    this.display();
                };
            }

            const downBtn = actionsWrapper.createEl('button', { text: '↓', cls: 'hp-hl-action-btn', attr: { title: 'Move Down' } });
            if (idx === this.plugin.settings.highlighters.length - 1) downBtn.disabled = true;
            else {
                downBtn.onclick = async () => {
                    const temp = this.plugin.settings.highlighters[idx + 1];
                    this.plugin.settings.highlighters[idx + 1] = this.plugin.settings.highlighters[idx];
                    this.plugin.settings.highlighters[idx] = temp;
                    await this.plugin.saveSettings();
                    this.display();
                };
            }

            const dupBtn = actionsWrapper.createEl('button', { text: '📄', cls: 'hp-hl-action-btn', attr: { title: 'Duplicate' } });
            dupBtn.onclick = async () => {
                const dupHl = JSON.parse(JSON.stringify(hl));
                let baseId = dupHl.id;
                let newId = baseId + '_copy';
                let counter = 1;
                while (this.plugin.settings.highlighters.some(h => h.id === newId)) {
                    newId = baseId + '_copy' + counter;
                    counter++;
                }
                dupHl.id = newId;
                this.plugin.settings.highlighters.splice(idx + 1, 0, dupHl);
                await this.plugin.saveSettings();
                this.highlightIdToFlash = newId; 
                this.display();
            };
            
            const delBtn = actionsWrapper.createEl('button', { text: '🗑️', cls: 'hp-hl-action-btn hp-hl-del-btn', attr: { title: 'Delete' } });
            delBtn.onclick = () => {
                new DeleteConfirmModal(this.app, hl.id, async () => {
                    this.plugin.ghostIds.add(hl.id);
                    
                    hl.styleType = 'background';
                    hl.light.opacity = 0;
                    hl.dark.opacity = 0;
                    hl.light.useCustomTextColor = false;
                    hl.dark.useCustomTextColor = false;
                    
                    this.plugin.injectGlobalStyles();
                    this.app.workspace.iterateAllLeaves((leaf) => {
                        if (leaf.view.getViewType() === 'markdown') {
                            const view = leaf.view as any;
                            if (view.previewMode) view.previewMode.rerender(true);
                            if (view.editor?.cm) view.editor.cm.dispatch({ effects: forceUpdateEffect.of(null) });
                        }
                    });

                    setTimeout(async () => {
                        const currentIdx = this.plugin.settings.highlighters.findIndex(h => h.id === hl.id);
                        if (currentIdx > -1) {
                            this.plugin.settings.highlighters.splice(currentIdx, 1);
                            await this.plugin.saveSettings();
                            this.display();
                        }
                    }, 100);

                }).open();
            };

            const body = card.createDiv({ cls: 'hp-hl-body' });

            const renderProfile = (colParent: HTMLElement, profile: HighlightProfile, isLight: boolean) => {
                const themeClass = isLight ? 'theme-light hp-theme-col' : 'theme-dark hp-theme-col';
                const col = colParent.createDiv({ cls: `hp-hl-col ${isLight ? 'hp-col-light-border' : ''}` });
                
                col.createDiv({ text: isLight ? '☀️ LIGHT THEME' : '🌙 DARK THEME', cls: 'hp-col-title' });

                const previewBox = col.createDiv({ cls: 'hp-preview-box' });
                const previewText = previewBox.createSpan({ text: 'sample text' });
                
                if (isLight) {
                    previewBox.style.backgroundColor = isAppDarkMode ? '#f8f8f8' : 'var(--background-primary)';
                    previewBox.style.color = isAppDarkMode ? '#222222' : 'var(--text-normal)';
                } else {
                    previewBox.style.backgroundColor = isAppDarkMode ? 'var(--background-primary)' : '#202020';
                    previewBox.style.color = isAppDarkMode ? 'var(--text-normal)' : '#eeeeee';
                }
                
                const updatePreview = () => {
                    const rgba = hexToRgba(profile.color, profile.opacity);
                    previewText.style.cssText = `border-radius: ${hl.borderRadius}px; padding: 0 3px;`;
                    if (profile.useCustomTextColor) {
                        previewText.style.color = profile.textColor;
                    }
                    if (hl.styleType === 'underline') {
                        previewText.style.borderBottom = `3px solid ${rgba}`;
                    } else {
                        previewText.style.backgroundColor = rgba;
                    }
                };
                updatePreview();

                const grid = col.createDiv({ cls: 'hp-theme-grid' });
                
                const hlCol = grid.createDiv({ cls: 'hp-grid-col' });
                hlCol.createDiv({ text: 'Highlight Color', cls: 'hp-grid-label' });
                const hlTools = hlCol.createDiv({ cls: 'hp-grid-tools' });
                
                const colorInp = hlTools.createEl('input', { attr: { type: 'color', value: profile.color, cls: 'hp-color-picker' }});
                colorInp.onchange = async () => { profile.color = colorInp.value; updatePreview(); await this.plugin.saveSettings(); };
                
                const opVal = hlTools.createSpan({ text: `${Math.round(profile.opacity * 100)}%`, cls: 'hp-op-val' });
                const opRange = hlTools.createEl('input', { attr: { type: 'range', min: '0', max: '1', step: '0.05', value: profile.opacity.toString(), title: 'Opacity' }});
                opRange.style.width = '55px';
                opRange.oninput = () => { opVal.innerText = `${Math.round(parseFloat(opRange.value) * 100)}%`; };
                opRange.onchange = async () => { profile.opacity = parseFloat(opRange.value); updatePreview(); await this.plugin.saveSettings(); };

                const txtCol = grid.createDiv({ cls: 'hp-grid-col' });
                txtCol.createDiv({ text: 'Text Color', cls: 'hp-grid-label' });
                const txtTools = txtCol.createDiv({ cls: 'hp-grid-tools' });
                
                const txtTglWrapper = txtTools.createDiv();
                const txtCp = txtTools.createEl('input', { attr: { type: 'color', value: profile.textColor, cls: 'hp-color-picker' } });
                
                txtCp.style.visibility = profile.useCustomTextColor ? 'visible' : 'hidden';

                new ToggleComponent(txtTglWrapper).setValue(profile.useCustomTextColor).onChange(async v => { 
                    profile.useCustomTextColor = v; 
                    txtCp.style.visibility = v ? 'visible' : 'hidden';
                    updatePreview(); 
                    await this.plugin.saveSettings(); 
                });
                
                txtCp.onchange = async () => { profile.textColor = txtCp.value; updatePreview(); await this.plugin.saveSettings(); };
            };

            renderProfile(body, hl.light, true);
            renderProfile(body, hl.dark, false);
        });

        const bottomActions = containerEl.createDiv({ cls: 'hp-bottom-actions' });
        
        new Setting(bottomActions)
            .addButton(b => b.setButtonText('Add highlighter').setCta().onClick(async () => {
                const maxId = this.plugin.settings.highlighters.reduce((max, hl) => {
                    const num = parseInt(hl.id);
                    return (!isNaN(num) && num > max) ? num : max;
                }, 0);
                
                let newId = (maxId + 1).toString();
                while (this.plugin.settings.highlighters.some(h => h.id === newId)) { 
                    newId = (parseInt(newId) + 1).toString() + '_x'; 
                }

                const randomHue = Math.floor(Math.random() * 360);
                const randomColor = hslToHex(randomHue, 40, 40);

                const profLight = { color: randomColor, opacity: 0.5, useCustomTextColor: true, textColor: '#fafafa' };
                const profDark = { color: randomColor, opacity: 0.5, useCustomTextColor: false, textColor: '#ffffff' };
                
                this.plugin.settings.highlighters.push({ id: newId, styleType: 'background', borderRadius: 3, isToggleable: true, toggleScope: 'all', light: { ...profLight }, dark: { ...profDark } });
                await this.plugin.saveSettings();
                this.highlightIdToFlash = newId; 
                this.display();
            }))
            .addButton(b => b.setButtonText('Configure hotkeys').onClick(() => {
                const settingApp = (this.app as any).setting;
                settingApp.openTabById('hotkeys');
                const tab = settingApp.activeTab;
                if (tab && tab.searchComponent) {
                    tab.searchComponent.setValue('highlighter-plus');
                    tab.updateHotkeyVisibility?.();
                }
            }))
            .addButton(b => b.setButtonText('Restore defaults').setWarning().onClick(() => {
                new RestoreDefaultsModal(this.app, async () => {
                    this.plugin.settings.highlighters = JSON.parse(JSON.stringify(DEFAULT_HIGHLIGHTERS));
                    await this.plugin.saveSettings();
                    this.display();
                }).open();
            }));

        const supportSection = containerEl.createDiv({ cls: 'hp-support-section' });
        new Setting(supportSection)
            .setName('Support development')
            .setDesc('If you enjoy using this plugin and would like to support my work, please consider using the button on the right. Thank you! ☕')
            .addButton(btn => btn
                .setButtonText('Buy me a coffee ❤')
                .onClick(() => {
                    window.open('https://buycoffee.to/creesee', '_blank');
                })
            );

        this.injectSettingsCSS();
    }

    injectSettingsCSS() {
        const styleId = 'hp-settings-layout-css';
        if (!document.getElementById(styleId)) {
            const style = document.head.createEl('style');
            style.id = styleId;
            style.textContent = `
                .hp-help-box { background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 12px 18px; font-size: 0.9em; margin-bottom: 20px; }
                .hp-help-box ul { margin: 5px 0 0 0; padding-left: 20px; }
                .hp-help-box li { margin-bottom: 4px; }
                
                .hp-settings-list { display: flex; flex-direction: column; gap: 24px; margin-bottom: 20px; }
                .hp-hl-card { border: 2px solid var(--background-modifier-border); border-radius: 8px; overflow: hidden; background: transparent; box-shadow: 0 4px 6px rgba(0,0,0,0.05); transition: box-shadow 0.3s ease, border-color 0.3s ease; }
                
                @keyframes hp-card-flash {
                    0% { border-color: var(--interactive-accent); box-shadow: 0 0 15px var(--interactive-accent); }
                    100% { border-color: var(--background-modifier-border); box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
                }
                .hp-hl-card-flash { animation: hp-card-flash 1.5s ease-out; }
                
                .hp-hl-header { display: flex; align-items: center; padding: 12px 15px; background: var(--background-secondary-alt); border-bottom: 1px solid var(--background-modifier-border); gap: 15px; overflow-x: auto; }
                
                .hp-hl-grid { display: flex; flex-direction: column; gap: 6px; flex-grow: 1; }
                .hp-hl-labels { display: grid; grid-template-columns: 80px 110px 130px 190px; gap: 15px; align-items: end; }
                .hp-hl-controls { display: grid; grid-template-columns: 80px 110px 130px 190px; gap: 15px; align-items: center; }
                
                .hp-hl-label { font-size: 0.7em; text-transform: uppercase; font-weight: 600; opacity: 0.7; letter-spacing: 0.5px; line-height: 1; margin-bottom: 2px; }
                .hp-hl-controls input[type="text"], .hp-hl-controls select { width: 100%; height: 26px; padding: 2px 6px; }
                .hp-hl-controls input[type="range"] { width: 100%; margin: 0; }
                .hp-hl-tgl-wrapper { display: flex; align-items: center; gap: 8px; height: 26px; }
                .hp-scope-sel { width: 120px !important; }
                .hp-rad-val { margin-left: 2px; font-weight: normal; text-transform: none; opacity: 0.8; }
                
                .hp-hl-actions-wrapper { display: flex; gap: 4px; margin-left: auto; align-items: center; height: 100%; }
                .hp-hl-action-btn { background: transparent; box-shadow: none; padding: 4px 8px; margin: 0; font-size: 1.1em; cursor: pointer; }
                .hp-hl-action-btn:hover { background: var(--background-modifier-hover); border-radius: 4px; }
                .hp-hl-action-btn:disabled { opacity: 0.3; cursor: not-allowed; background: transparent; }
                .hp-hl-del-btn:hover { background: var(--background-modifier-error); color: white; border-radius: 4px; }
                
                .hp-hl-body { display: flex; flex-wrap: wrap; }
                .hp-hl-col { flex: 1; min-width: 260px; padding: 12px 15px; display: flex; flex-direction: column; gap: 10px; }
                .hp-col-light-border { border-right: 1px solid var(--background-modifier-border); }
                
                .hp-theme-col { background-color: var(--background-primary); color: var(--text-normal); }
                
                .hp-col-title { font-size: 0.8em; font-weight: bold; letter-spacing: 0.5px; opacity: 0.7; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 4px; }
                .hp-preview-box { padding: 10px; border-radius: 4px; text-align: center; border: 1px solid var(--background-modifier-border); margin-bottom: 5px; }
                
                .hp-theme-grid { display: flex; gap: 15px; margin-top: 5px; }
                .hp-grid-col { display: flex; flex-direction: column; gap: 6px; flex: 1; }
                .hp-grid-label { font-size: 0.8em; opacity: 0.8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
                .hp-grid-tools { display: flex; align-items: center; gap: 8px; height: 26px; }
                
                .hp-color-picker { width: 26px; height: 26px; padding: 0; border: 1px solid rgba(128,128,128,0.5) !important; border-radius: 50% !important; cursor: pointer; overflow: hidden; }
                .hp-color-picker::-webkit-color-swatch-wrapper { padding: 0; }
                .hp-color-picker::-webkit-color-swatch { border: none; }
                
                .hp-op-val { display: inline-block; width: 35px; text-align: right; opacity: 0.7; font-size: 0.9em; }
                
                .hp-bottom-actions { border-top: 1px solid var(--background-modifier-border); padding-top: 10px; margin-bottom: 10px; }
                .hp-bottom-actions .setting-item { border: none; padding: 0; }
                
                .hp-support-section { border-top: 1px solid var(--background-modifier-border); padding-top: 5px; }
                .hp-support-section .setting-item { border: none; }
            `;
        }
    }
}