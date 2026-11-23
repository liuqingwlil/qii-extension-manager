"""Shared Tk theme and home screen for the Windows migration assistant."""

from pathlib import Path
import tkinter as tk
from tkinter import font, ttk


BG = "#F7F8F4"
SURFACE = "#FFFFFF"
BORDER = "#DEE5DF"
TEXT = "#253F34"
MUTED = "#52655C"
ACCENT = "#285140"
SELECTED = "#E5EDE4"
SCROLL_TRACK = "#F0F3EF"


class Theme:
    def __init__(self, root):
        self.root = root
        self.scale = root.winfo_fpixels("1i") / 96
        family = "Microsoft YaHei UI" if root.tk.call("tk", "windowingsystem") == "win32" else "TkDefaultFont"
        if family == "TkDefaultFont":
            family = font.nametofont(family, root=root).actual("family")
        self.body = font.Font(root=root, family=family, size=10)
        self.emphasis = font.Font(root=root, family=family, size=10, weight="bold")
        self.keyboard_body = self.body.copy()
        self.keyboard_body.configure(underline=True)
        self.keyboard_emphasis = self.emphasis.copy()
        self.keyboard_emphasis.configure(underline=True)
        self.style = ttk.Style(root)
        self.style.theme_use("clam")
        self._styles(family)
        self.images = self._load_images()
        if "icon" in self.images:
            root.iconphoto(True, self.images["icon"])

        self._using_keyboard = False
        self._focused_control = None
        self._focused_item = ""
        self._focus_pending = False
        # Process keyboard traversal before Tk's default bindings consume Tab.
        root.bind_class("QiiInput", "<KeyPress>", self._keyboard_input)
        root.bind_class("QiiInput", "<ButtonPress>", self._pointer_input)
        root.bind_all("<ButtonPress>", self._pointer_input, add=True)
        root.bind_all("<FocusIn>", self._schedule_focus_update, add=True)
        root.bind_all("<FocusOut>", self._schedule_focus_update, add=True)

    def px(self, pixels):
        return round(pixels * self.scale)

    def _styles(self, family):
        style = self.style
        style.configure(".", font=self.body, foreground=TEXT, background=BG)
        style.configure("TFrame", background=BG)
        style.configure("Card.TFrame", background=SURFACE, bordercolor=BORDER,
                        lightcolor=BORDER, darkcolor=BORDER, relief="solid", borderwidth=1)
        style.configure("TLabel", background=BG, foreground=TEXT)
        style.configure("Title.TLabel", font=(family, 22, "bold"))
        style.configure("Heading.TLabel", font=(family, 17, "bold"))
        style.configure("Hint.TLabel", foreground=MUTED)
        style.configure("Small.TLabel", foreground=MUTED, font=(family, 9))
        style.configure("Card.TLabel", background=SURFACE)
        style.configure("CardTitle.TLabel", background=SURFACE, font=(family, 13, "bold"))
        style.configure("CardHint.TLabel", background=SURFACE, foreground=MUTED)
        style.configure("Error.TLabel", foreground="#874638")

        # The stock clam button draws a separate focus rectangle even on a mouse click.
        style.layout("TButton", [("Button.border", {"sticky": "nswe", "children": [
            ("Button.padding", {"sticky": "nswe", "children": [("Button.label", {"sticky": "nswe"})]})
        ]})])
        style.configure("TButton", anchor="center", relief="solid", width=0,
                        padding=(self.px(15), self.px(8)), borderwidth=1)
        for name, base, hover, pressed, edge, ink in (
            ("Primary.TButton", ACCENT, "#315D4A", "#1F4234", ACCENT, SURFACE),
            ("TButton", SURFACE, "#F2F5F1", "#E8EEE7", "#C8D5CB", TEXT),
            ("Quiet.TButton", BG, "#EEF2EC", "#E5ECE4", BG, TEXT),
        ):
            style.configure(name, font=self.emphasis, background=base, foreground=ink,
                            bordercolor=edge, lightcolor=edge, darkcolor=edge)
            style.map(name,
                      background=[("disabled", "#EDF1EC"), ("pressed", "!disabled", pressed), ("active", "!disabled", hover)],
                      foreground=[("disabled", "#687870")],
                      bordercolor=[("disabled", BORDER)],
                      lightcolor=[("disabled", BORDER)], darkcolor=[("disabled", BORDER)],
                      relief=[],
                      font=[("user1", self.keyboard_emphasis)])

        style.configure("TEntry", padding=(self.px(9), self.px(6)), fieldbackground=SURFACE,
                        bordercolor="#C8D5CB", lightcolor=SURFACE, foreground=TEXT,
                        selectbackground="#D9E7DA", selectforeground=TEXT)
        style.map("TEntry", background=[("readonly", SURFACE)],
                  fieldbackground=[("user1", "#EFF4EE"), ("readonly", SURFACE)],
                  bordercolor=[("invalid", "#AD6A53"), ("focus", "#C8D5CB")],
                  lightcolor=[("focus", SURFACE)])

        row_height = max(self.px(34), self.body.metrics("linespace") + self.px(12))
        style.configure("Treeview", font=self.body, rowheight=row_height, background=SURFACE,
                        fieldbackground=SURFACE, stripedbackground="#F9FAF8", borderwidth=1,
                        bordercolor=BORDER, lightcolor=BORDER, darkcolor=BORDER)
        style.map("Treeview", background=[("selected", SELECTED)],
                  foreground=[("selected", TEXT)], bordercolor=[("focus", BORDER)])
        style.configure("Treeview.Heading", font=self.emphasis, padding=(self.px(8), self.px(8)),
                        background="#EFF3EF", bordercolor=BORDER, lightcolor=BORDER,
                        darkcolor=BORDER, relief="flat")
        style.map("Treeview.Heading", background=[("active", "#EFF3EF"), ("pressed", "#EFF3EF")],
                  relief=[])
        style.configure("Treeview.Item", padding=(self.px(6), 0))

        for axis, sticky in (("Vertical", "ns"), ("Horizontal", "we")):
            name = f"{axis}.TScrollbar"
            style.layout(name, [(f"{axis}.Scrollbar.trough", {"sticky": sticky, "children": [
                (f"{axis}.Scrollbar.thumb", {"sticky": "nswe"})
            ]})])
            style.configure(name, troughcolor=SCROLL_TRACK, background="#CFDAD1",
                            bordercolor=SCROLL_TRACK, lightcolor="#CFDAD1", darkcolor="#CFDAD1",
                            arrowsize=self.px(11), gripsize=0, relief="flat")
            thumb = [("disabled", SCROLL_TRACK), ("pressed", "#ACBEB1"), ("active", "#BFCFC3")]
            style.map(name, background=thumb, lightcolor=thumb, darkcolor=thumb)

        style.configure("Horizontal.TProgressbar", troughcolor="#E6EEE5", background="#6F987E",
                        lightcolor="#6F987E", darkcolor="#6F987E", bordercolor="#E6EEE5",
                        thickness=self.px(8))

    def _load_images(self):
        directory = Path(__file__).resolve().parent
        images = {}
        for name, filename in (
            ("folder", "migration-folder.png"),
            ("export", "export.png"),
            ("import", "import.png"),
            ("icon", "icon32.png"),
            ("warning", "warning.png"),
            ("success", "success.png"),
        ):
            path = directory / "assets" / filename
            if name == "icon" and not path.is_file():
                path = directory.parent.parent / "public" / "icons" / filename
            if path.is_file():
                image = tk.PhotoImage(master=self.root, file=str(path))
                scale = max(1, round(self.scale * 4))
                images[name] = image.zoom(scale).subsample(4, 4) if scale != 4 and name != "icon" else image
        return images

    def prepare_window(self, window, size, minimum=None, parent=None):
        self._track_input(window)
        window.configure(background=BG)
        screen_width = window.winfo_screenwidth()
        screen_height = window.winfo_screenheight()
        width = min(self.px(size[0]), screen_width - self.px(28))
        height = min(self.px(size[1]), screen_height - self.px(74))
        if minimum:
            window.minsize(min(width, self.px(minimum[0])), min(height, self.px(minimum[1])))
        x, y = screen_width // 2, screen_height // 2
        if parent is not None and parent.winfo_viewable():
            x = parent.winfo_rootx() + parent.winfo_width() // 2
            y = parent.winfo_rooty() + parent.winfo_height() // 2
        left, top = x - width // 2, y - height // 2
        # Primary display limits do not apply when the owner is on another display.
        if 0 <= x < screen_width and 0 <= y < screen_height:
            left = max(0, min(left, screen_width - width - self.px(12)))
            top = max(0, min(top, screen_height - height - self.px(55)))
        window.geometry(f"{width}x{height}+{left}+{top}")

    def frame(self, parent, *, style="TFrame", **options):
        return ttk.Frame(parent, style=style, **options)

    def label(self, parent, text=None, *, style="TLabel", wrap=False, **options):
        if wrap:
            options.setdefault("justify", "left")
            options.setdefault("wraplength", self.px(280))
        if text is not None:
            options["text"] = text
        label = ttk.Label(parent, style=style, **options)
        if wrap:
            label.bind("<Configure>", self._update_wrap, add=True)
        return label

    def _update_wrap(self, event):
        if event.width > self.px(32) and int(event.widget.cget("wraplength")) != event.width:
            event.widget.configure(wraplength=event.width)

    def button(self, parent, text, command, *, kind="secondary", **options):
        styles = {"primary": "Primary.TButton", "secondary": "TButton", "quiet": "Quiet.TButton"}
        return self._track_input(ttk.Button(parent, text=text, command=command, style=styles[kind], **options))

    def table(self, parent, columns, *, height=7):
        container = self.frame(parent)
        container.columnconfigure(0, weight=1)
        container.rowconfigure(0, weight=1)
        names = tuple(column[0] for column in columns)
        tree = self._track_input(ttk.Treeview(
            container, columns=names, show="headings", selectmode="browse", height=height))
        if "striped" in tree.keys():
            tree.configure(striped=True)
        for key, label, width, minimum in columns:
            tree.heading(key, text=label, anchor="w")
            tree.column(key, width=self.px(width), minwidth=self.px(minimum),
                        stretch=key == names[-1], anchor="w")
        tree.tag_configure("keyboard-focus", font=self.keyboard_body)
        tree.bind("<<TreeviewSelect>>", self._schedule_focus_update, add=True)
        vertical = ttk.Scrollbar(container, orient="vertical", command=tree.yview, takefocus=False)
        horizontal = ttk.Scrollbar(container, orient="horizontal", command=tree.xview, takefocus=False)
        tree.configure(yscrollcommand=lambda first, last: self._set_scrollbar(vertical, first, last),
                       xscrollcommand=lambda first, last: self._set_scrollbar(horizontal, first, last))
        tree.grid(row=0, column=0, sticky="nsew")
        vertical.grid(row=0, column=1, sticky="ns", padx=(self.px(3), 0))
        horizontal.grid(row=1, column=0, sticky="ew", pady=(self.px(3), 0))
        return container, tree

    @staticmethod
    def _set_scrollbar(scrollbar, first, last):
        scrollbar.set(first, last)
        fully_visible = float(first) == 0 and float(last) == 1
        scrollbar.state(("disabled" if fully_visible else "!disabled",))

    def copy_field(self, parent, value="", *, textvariable=None, **options):
        variable = textvariable if textvariable is not None else tk.StringVar(master=parent, value=value)
        entry = self.entry(parent, textvariable=variable, state="readonly", **options)
        entry.copy_value = variable
        return entry

    def entry(self, parent, **options):
        options.setdefault("font", self.body)
        return self._track_input(ttk.Entry(parent, **options))

    @staticmethod
    def _track_input(widget):
        tags = widget.bindtags()
        if "QiiInput" not in tags:
            widget.bindtags(("QiiInput", *tags))
        return widget

    @staticmethod
    def _clear_item_focus(tree, item):
        if item and tree.exists(item):
            tags = tuple(tag for tag in tree.item(item, "tags") if tag != "keyboard-focus")
            tree.item(item, tags=tags)

    def _keyboard_input(self, _event):
        self._using_keyboard = True
        self._schedule_focus_update()

    def _pointer_input(self, _event):
        self._using_keyboard = False
        self._schedule_focus_update()

    def _schedule_focus_update(self, _event=None):
        if not self._focus_pending:
            self._focus_pending = True
            self.root.after_idle(self._update_focus)

    def _update_focus(self):
        self._focus_pending = False
        try:
            current = self.root.focus_get() if self._using_keyboard else None
        except (tk.TclError, KeyError):
            current = None
        previous = self._focused_control
        if previous is not current:
            if isinstance(previous, ttk.Widget) and previous.winfo_exists():
                previous.state(("!user1",))
                if isinstance(previous, ttk.Entry):
                    previous.configure(font=self.body)
                elif isinstance(previous, ttk.Treeview):
                    self._clear_item_focus(previous, self._focused_item)
            self._focused_control = current
            self._focused_item = ""
            if isinstance(current, ttk.Widget):
                current.state(("user1",))
                if isinstance(current, ttk.Entry):
                    current.configure(font=self.keyboard_body)

        if isinstance(current, ttk.Treeview):
            item = current.focus()
            if not item:
                rows = current.selection() or current.get_children()
                if rows:
                    item = rows[0]
                    current.focus(item)
                    current.selection_set(item)
                    current.see(item)
            if item != self._focused_item:
                self._clear_item_focus(current, self._focused_item)
                if item:
                    current.item(item, tags=(*current.item(item, "tags"), "keyboard-focus"))
                self._focused_item = item

    def home(self, interface, version, export, restore):
        root = interface.root
        panel = self.frame(root, padding=(self.px(28), self.px(22), self.px(28), self.px(18)))
        panel.pack(fill="both", expand=True)
        panel.columnconfigure(0, weight=1)
        panel.rowconfigure(3, weight=1)

        header = self.frame(panel)
        header.grid(row=0, column=0, sticky="ew", pady=(0, self.px(14)))
        header.columnconfigure(0, weight=1)
        header_text = self.frame(header)
        header_text.grid(row=0, column=0, sticky="w")
        self.label(header_text, "把扩展文件一起带走", style="Title.TLabel").pack(anchor="w")
        self.label(header_text, "备份或恢复 Chrome 与 Edge 的扩展文件", style="Hint.TLabel").pack(
            anchor="w", pady=(self.px(6), 0))
        if "folder" in self.images:
            self.label(header, image=self.images["folder"]).grid(row=0, column=1, padx=(self.px(12), self.px(20)))

        cards = self.frame(panel)
        cards.grid(row=1, column=0, sticky="ew", pady=(0, self.px(14)))
        cards.columnconfigure((0, 1), weight=1, uniform="file-actions")
        self._file_card(cards, "export", "导出扩展文件", "将所选资料的扩展文件打包为 ZIP。",
                        "导出 ZIP", export).grid(row=0, column=0, sticky="nsew", padx=(0, self.px(7)))
        self._file_card(cards, "import", "导入扩展文件", "校验 ZIP 并将扩展文件恢复到新目录。",
                        "导入 ZIP", restore).grid(row=0, column=1, sticky="nsew", padx=(self.px(7), 0))

        connection = self.frame(panel, style="Card.TFrame", padding=(self.px(16), self.px(13)))
        connection.grid(row=2, column=0, sticky="ew")
        connection.columnconfigure(0, weight=1)
        self.label(connection, "管理器连接", style="CardTitle.TLabel").grid(row=0, column=0, sticky="w")
        self.label(connection, style="CardHint.TLabel", textvariable=interface.connection_status, wrap=True).grid(
            row=1, column=0, sticky="ew", padx=(0, self.px(14)), pady=(self.px(4), 0))
        self.button(connection, "自动连接管理器", lambda: interface.automatic_connection(True), kind="primary").grid(
            row=1, column=1, sticky="e", padx=(0, self.px(8)))
        self.button(connection, "手动填写扩展 ID", interface.register).grid(row=1, column=2, sticky="e")

        self.label(panel, f"v{version}  ·  文件仅在本机处理", style="Small.TLabel").grid(
            row=4, column=0, sticky="w", pady=(self.px(12), 0))

    def _file_card(self, parent, artwork, title, description, action, command):
        card = self.frame(parent, style="Card.TFrame", padding=self.px(16))
        card.columnconfigure(1, weight=1)
        card.rowconfigure(1, weight=1)
        image = self.images.get(artwork)
        if image is not None:
            self.label(card, style="Card.TLabel", image=image).grid(
                row=0, column=0, rowspan=2, sticky="nw", padx=(0, self.px(12)))
        self.label(card, title, style="CardTitle.TLabel").grid(row=0, column=1, sticky="w")
        self.label(card, description, style="CardHint.TLabel", wrap=True).grid(
            row=1, column=1, sticky="new", pady=(self.px(4), self.px(10)))
        self.button(card, action, command, kind="primary", width=12).grid(row=2, column=1, sticky="w")
        return card
