import {GenkoYoshi} from "./genkoyoshi.js";
import {Settings} from "./settings.js";

// Google Apps Script(GAS)のWebアプリ of のデプロイURLを設定します
// スプレッドシート連携を有効にするには、ここにURLを記述してください。
const GAS_URL = "https://script.google.com/macros/s/AKfycbydYWFMAqxBNQ9GEhzkwSzuFe782cJRAFddOrJVzhZWbS0VcHuPz7p1vidcmdpV2QvhoQ/exec";
const SESSION_TOKEN_KEY = "genko_sessionToken";
const RECOVERY_DRAFT_PREFIX = "genko_pendingDraft:";
let authExpiryHandled = false;

function getSessionToken() {
    return window.sessionStorage.getItem(SESSION_TOKEN_KEY) || "";
}

function withSession(payload) {
    return {
        ...payload,
        sessionToken: getSessionToken()
    };
}

function handleExpiredSession() {
    if (authExpiryHandled) return;
    authExpiryHandled = true;

    window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
    window.localStorage.removeItem("genko_studentName");
    alert("安全のためログインの有効期限が切れました。もう一度ログインしてください。");
    window.location.reload();
}

// ローカル開発時だけ有効になる確認モード。本番URLでは ?dev=1 を付けても動作しません。
const IS_DEV_MODE = ["localhost", "127.0.0.1"].includes(window.location.hostname)
    && new URLSearchParams(window.location.search).get("dev") === "1";
const DEV_MOCK_DATA = {
    classNumber: "1",
    studentId: "12",
    studentName: "開発用 児童",
    writingType: "課題図書",
    writingTitle: "心に残った場面",
    bookName: "銀河鉄道の夜",
    text: "ぼくがこの本を読んで、いちばん心に残ったのは、二人が列車の中で話をする場面です。\n登場人物の気持ちを考えながら読むと、最初に読んだときとはちがう発見がありました。",
    teacherComment: "場面の様子がよく伝わる作文です。最後の段落で、自分がこれからどうしたいかをもう少し詳しく書くと、さらに分かりやすくなります。"
};
const WRITING_TYPE_LABELS = {
    "none": "指定なし",
    "課題図書": "読書感想文（課題図書）",
    "自由図書": "読書感想文（自由図書）",
    "人権": "人権作文",
    "健康": "健康作文",
    "交通": "交通安全作文"
};

/**
 * 通信失敗時に自動リトライを行う fetch のラッパー関数
 * Google Apps Script やスプレッドシートの同時アクセス制限（時間制限やリソース上限）対策
 */
async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        // レスポンスが正常なJSONかどうかを事前チェックし、パースエラー時もリトライ対象にする
        const clone = response.clone();
        let responseData;
        try {
            responseData = await clone.json();
        } catch (jsonErr) {
            throw new Error(`Invalid JSON response: ${jsonErr.message}`);
        }

        if (responseData && responseData.status === "unauthorized") {
            handleExpiredSession();
            const authError = new Error(responseData.message || "ログインの有効期限が切れました。");
            authError.noRetry = true;
            throw authError;
        }
        
        return response;
    } catch (err) {
        if (err.noRetry) throw err;
        if (retries > 0) {
            console.warn(`通信エラーのためリトライします。残り回数: ${retries}回。エラー:`, err);
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(url, options, retries - 1, delay * 1.5);
        }
        throw err;
    }
}

class Main {
    constructor() {
        this.browser = (/(msie|trident|edge|chrome|safari|firefox|opera)/
                .exec(window.navigator.userAgent.toLowerCase()) || ["other"]).pop().replace("trident", "msie");

        this.genko = new GenkoYoshi($(".genko"), 20, 20);
        this.settings = new Settings($("#controlPane"), this);
        this.autoSaveTimer = null; // GAS自動保存用タイマー
        this.savePromise = null;
        this.saveRequested = false;
        this.contentRevision = 0;
        this.lastSavedRevision = 0;
        this.printDetailsTimer = null;
        this.pageDetailsObserver = null;
        this.isDevMode = IS_DEV_MODE;
        this.devStudent = DEV_MOCK_DATA;

        $(window).on("pagehide", this.onClosing.bind(this));
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") this.onClosing();
        });
        setInterval(this.onTimerSaving.bind(this), 5 * 60 * 1000);

        this.$pageCss = $("<style>").appendTo($("head"));
        this.$backdrop = null;

        this.studentRoster = null;
        
        this.$loginClassNum = $("#login-class-num").change(this.onClassNumChanged.bind(this));
        this.$loginStudentSelect = $("#login-student-select");
        this.$loginPassword = $("#login-password"); // パスワードフィールド
        this.$teacherSidebar = $("#teacher-sidebar"); // 教師用児童切り替えサイドバー
        this.currentTeacherComment = "";
        this.currentPrintStudent = null;
        this.teacherSelectionRevision = 0;

        // 児童用コントロールパネルのバインド
        this.$studentControlPanel = $("#student-control-panel");
        this.$completeBtn = $("#completeBtn").click(this.onCompleteToggleClicked.bind(this));
        this.isCompletedStatus = false; // できた！（完成）フラグ

        // 保存ステータスボタンのバインド
        this.$saveStatusBtn = $("#saveStatusBtn").click(this.onSaveStatusBtnClicked.bind(this));
        this.saveStatus = "saved"; // "saved", "dirty", "saving", "error"

        // ログイン要素の初期化
        this.$dialogLogin = $("#dialog-login").modal({show: false, backdrop: 'static', keyboard: false});
        $("#loginForm").submit(this.onLoginSubmitted.bind(this));
        $("#logoutBtn").click(this.onLogoutClicked.bind(this));

        // リアルタイムの文字入力を監視
        $(document).on("input", this.onInputChanged.bind(this));

        // Buttons
        this.$saveBtn = $("#saveBtn").click(this.onSaveClicked.bind(this));
        this.$undoBtn = $("#undoBtn").click(this.onUndoClicked.bind(this));
        this.$redoBtn = $("#redoBtn").click(this.onRedoClicked.bind(this));
        this.$printBtn = $("#printBtn").click(this.onPrintClicked.bind(this));
        this.$fullscreenBtn = $("#fullscreenBtn").click(this.onFullscreenClicked.bind(this));

        // Export text
        this.$exportBtn = $("#export-text").click(this.onExportTextClicked.bind(this));
        this.$dialogExport = $("#dialog-export").modal({show: false});
        this.$dialogExport.find(".btn-okay").click(this.onExportTextConfirmed.bind(this));

        // Copy image to clipboard
        this.$copyImageBtn = $("#copy-image").click(this.onCopyImageClicked.bind(this));

        // Export as image
        this.$exportImageBtn = $("#export-image").click(this.onExportImageClicked.bind(this));
        this.$dialogExportImage = $("#dialog-export-image").modal({show: false});
        this.$dialogExportImage.find("#btn-export-image").click(this.onExportImageConfirmed.bind(this));
        $(".btn-image-export-mode input").change(this.updateExportImageMode.bind(this));

        // 印刷イベントをフックして、用紙内のコメントと児童情報を最新にする
        window.onbeforeprint = () => {
            window.originalTitleForPrint = document.title;
            document.title = "\u200B";

            const printData = this.getCurrentPrintData();
            if (printData) {
                const $papers = this.getPages();
                this.appendPrintFooters($papers, printData);
                this.appendTeacherCommentToFirstPage($papers, printData.teacherComment || "");
            }
        };
        window.onafterprint = () => {
            if (window.originalTitleForPrint !== undefined) {
                document.title = window.originalTitleForPrint;
            }
            
            // 印刷終了後も、児童・教師・開発用の各画面に赤字コメントを残す
            const printData = this.getCurrentPrintData();
            this.appendTeacherCommentToFirstPage(this.getPages(), printData?.teacherComment || "");

        };

        // Twitter share button
        $("#share-twitter").click(this.onShareTwitterClicked.bind(this));

        // Define drawer action
        this.$drawers = $(".drawer");
        this.$drawers.each((idx, drawer) => {
            $(drawer).find(".drawer-accordion-box").hide();
            $(drawer).find(".drawer-header").click(e => this.onDrawerClicked(e, $(drawer)));
        });

        $(document).on('click touchend', e => {
            if (!$(e.target).closest(".drawer").length) {
                this.$drawers.find(".drawer-accordion-box").hide(200);
                this.$drawers.removeClass("active");
            }
        });
    }

    async setup() {
        try {
            // 原稿用紙の初期化（非同期）を待ちます
            await this.genko.init();
            
            this.settings.init();
            this.setupPageDetailsObserver();
            this.$writingTitleInput = $("#writingTitleInput");
            this.$writingTypeSelect = $("#writingTypeSelect").on("change", this.onWritingTypeChanged.bind(this));
            this.setPrintPageSize(this.genko.rowSize, this.genko.colSize);
            $('[data-toggle="tooltip"]').tooltip();

            if (this.isDevMode) {
                this.setupDevelopmentMode();
                return;
            }
            
            // 起動時は毎回ログインを求めるため、ログイン完了状態を示す氏名のみクリアする
            // 入場券とパスワードも残さない（クラスと出席番号だけは前回値を使います）
            window.localStorage.removeItem("genko_studentName");
            window.localStorage.removeItem("genko_password");
            window.sessionStorage.removeItem(SESSION_TOKEN_KEY);

            // ログイン状態を検証
            await this.checkLoginStatus(); 
        } catch (err) {
            console.error("初期化中にエラーが発生しました:", err);
        }
    }

    onDrawerClicked(e, $drawer) {
        var $accordion = $drawer.find(".drawer-accordion-box");
        var toggle = !$drawer.hasClass("active");

        this.$drawers.find(".drawer-accordion-box").hide(200);
        this.$drawers.removeClass("active");

        if (toggle) {
            $accordion.show(200);
        } else {
            $accordion.hide(200);
        }
        $drawer.toggleClass("active", toggle);
    }

    onUndoClicked() {
        this.genko.undo();
        this.updateSaveStatus("dirty");
        this.triggerAutoSaveToServer();
        this.scheduleScreenPrintDetails();
    }

    onRedoClicked() {
        this.genko.redo();
        this.updateSaveStatus("dirty");
        this.triggerAutoSaveToServer();
        this.scheduleScreenPrintDetails();
    }

    setPrintPageSize(rows, cols) {
        if (rows == 20 && cols == 20) {
            // 400字詰
            this.$pageCss.html("@page {size: A4 landscape; margin: 0;}")
        } else if (rows == 10 && cols == 20) {
            // 200字詰
            this.$pageCss.html("@page {size: A5 portrait; margin: 0;}")
        } else {
            this.$pageCss.html("");
        }
    }

    onSaveClicked() {
        this.triggerAutoSaveToServer(true);
    }

    onFullscreenClicked() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    }

    onPrintClicked() {
        window.print();
    }

    onExportTextClicked(e) {
        this.$dialogExport.modal("show");
    }

    onExportTextConfirmed(e) {
        var text = this.genko.getText();
        var link = document.createElement("a");
        var url = URL.createObjectURL(new Blob([text], {type: "text/plain"}));
        link.href = url;
        link.download = this.$dialogExport.find("#export-filename").val();
        //link.dataset.downloadurl = ["text/plain", link.download, link.href].join(":");
        link.click();
        this.$dialogExport.modal("hide");
    }

    onExportImageClicked(e) {
        this.$dialogExportImage.modal("show");
        this.updateExportImageMode();
    }
    
    onExportImageConfirmed(e) {
        const $pages = this.getPages();
        const isSinglePage = $pages.length == 1;
        const isAllInOne = $("#imageExportAllInOne").is(":checked") || isSinglePage;
        const funcExportAsImage = isAllInOne ? this.exportAsImage : this.exportAsImageEachPage;

        this.$dialogExportImage.modal("hide");
        this.startProcessing("backdrop-export-image")
            .then(funcExportAsImage.bind(this))
            .then(this.endProcessing.bind(this));
    }

    updateExportImageMode() {
        const $pages = this.getPages();
        const isSinglePage = $pages.length == 1;
        const isAllInOne = $("#imageExportAllInOne").is(":checked");
        let postfix;

        $(".btn-image-export-mode")
            .toggleClass("disabled", isSinglePage)
            .toggleClass("btn-outline-primary", !isSinglePage)
            .toggleClass("btn-outline-secondary", isSinglePage)
            .attr("inert", isSinglePage ? "inert" : null);

        if (isAllInOne || isSinglePage) {
            postfix = ".png";
            $("#imageFilePagingDesc").hide();
        } else {
            postfix = "-<i>ページ数</i>.png";
            $("#imageFilePagingDesc").show();
        }
        $("#image-filename-postfix").html(postfix);
    }

    exportAsImage() {
        return new Promise((resolve, reject) => {
            $(document).scrollTop(0);
            $("body").css({"padding": "0"});
            $(".genko").css({"padding": "5mm", "margin": "0", "justify-content": "left", "width": "min-content"});
            $(".genko-body").css({"margin": "0"});
            $(".genko-paper").css({"margin": "5mm"});
            $(".genko-paper.blank").hide();
            html2canvas(document.querySelector(".genko"), {
                foreignObjectRendering: this.browser != "safari",
                //useCORS: true,
                //allowTaint: true,
                windowWidth: $(".genko").width(),
                ignoreElements: elem => $(elem).is(".genko-ime, .genko-caret"),
                onclone: (doc) => {
                    $(doc).find(".genko-paper").css({"box-shadow": "none"}).removeClass("newline-visible");
                    $(doc).find(".char-body:has(.fw-space)").html("<div/>");
                    $(doc).find(".char-body:has(.newline), .char-body:has(.hw-space.single)").html("<div/>");
                    $(doc).find(".newline-after").each((idx, e) => {
                        $(e).text($(e).text());
                    });
                    $(doc).find(".hw-space.after").each((idx, e) => {
                        $(e).text($(e).text() + "\xa0");
                    })
                    $(doc).find(".hw-space.before").each((idx, e) => {
                        $(e).text("\xa0" + $(e).text());
                    })
                }
            }).then(canvas => {
                // $("body").append(canvas); // Output image on screen for debugging
                $("body").css({"padding": ""});
                $(".genko").css({"padding": "", "margin": "", "justify-content": "", "width": ""});
                $(".genko-body").css({"margin": ""});
                $(".genko-paper").css({"margin": ""});
                $(".genko-paper.blank").show();
                var link = document.createElement("a");
                var url = canvas.toDataURL();
                var filename = $("#export-image-filename").val() + ".png"
                link.href = url;
                link.download = filename;
                link.click();
                $(() => resolve())
            });
        });
    }

    async exportAsImageEachPage() {
        let $pages = this.getPages();
        $(document).scrollTop(0);
        $("body").css({"padding": "0"});
        $(".genko").css({"padding": "5mm", "margin": "0", "justify-content": "left", "width": "min-content"});
        $(".genko-body").css({"margin": "0"});
        $(".genko-paper").css({"margin": "5mm"});
        $(".genko-paper.blank").hide();
        try {
            for (const [idx, page] of $pages.toArray().entries()) {
                $pages.hide();
                $(page).show();
                const canvas = await html2canvas(document.querySelector(".genko"), {
                    foreignObjectRendering: this.browser != "safari",
                    onclone: (doc) => {
                        $(doc).find(".genko-paper").css({"box-shadow": "none"}).removeClass("newline-visible");
                        $(doc).find(".char-body:has(.fw-space)").html("<div/>");
                        $(doc).find(".char-body:has(.newline), .char-body:has(.hw-space.single)").html("<div/>");
                        $(doc).find(".newline-after").each((idx, e) => {
                            $(e).text($(e).text());
                        });
                        $(doc).find(".hw-space.after").each((idx, e) => {
                            $(e).text($(e).text() + "\xa0");
                        })
                        $(doc).find(".hw-space.before").each((idx, e) => {
                            $(e).text("\xa0" + $(e).text());
                        })
                    }
                });
                var link = document.createElement("a");
                var url = canvas.toDataURL();
                var filename = $("#export-image-filename").val() + `-${(idx + 1).toString().padStart(2, "0")}.png`
                link.href = url;
                link.download = filename;
                link.click();
            }
        } finally {
            $pages.show();
            $("body").css({"padding": ""});
            $(".genko").css({"padding": "", "margin": "", "justify-content": "", "width": ""});
            $(".genko-body").css({"margin": ""});
            $(".genko-paper").css({"margin": ""});
            $(".genko-paper.blank").show();
        }
    }

    onCopyImageClicked(e) {
        this.startProcessing("backdrop-copy-image")
            .then(this.copyAsImage.bind(this))
            .then(this.endProcessing.bind(this))
            .catch(err => {
                this.endProcessing();
                console.error("画像コピーエラー:", err);
                alert("画像のコピー中にエラーが発生しました:\n" + err.message);
            });
    }

    async copyAsImage() {
        let $pages = this.getPages();
        $(document).scrollTop(0);
        $("body").css({"padding": "0"});
        $(".genko").css({"padding": "5mm", "margin": "0", "justify-content": "left", "width": "min-content"});
        $(".genko-body").css({"margin": "0"});
        $(".genko-paper").css({"margin": "5mm"});
        $(".genko-paper.blank").hide();

        try {
            const canvas = await html2canvas(document.querySelector(".genko"), {
                scale: 1.5,
                foreignObjectRendering: this.browser != "safari",
                onclone: (doc) => {
                    $(doc).find(".genko-paper").css({"box-shadow": "none"}).removeClass("newline-visible");
                    $(doc).find(".char-body:has(.fw-space)").html("<div/>");
                    $(doc).find(".char-body:has(.newline), .char-body:has(.hw-space.single)").html("<div/>");
                    $(doc).find(".newline-after").each((idx, e) => {
                        $(e).text($(e).text());
                    });
                    $(doc).find(".hw-space.after").each((idx, e) => {
                        $(e).text($(e).text() + "\xa0");
                    });
                    $(doc).find(".hw-space.before").each((idx, e) => {
                        $(e).text("\xa0" + $(e).text());
                    });
                }
            });

            return new Promise((resolve, reject) => {
                canvas.toBlob(async (blob) => {
                    if (!blob) {
                        reject(new Error("画像の生成に失敗しました。"));
                        return;
                    }
                    if (navigator.clipboard && window.ClipboardItem) {
                        try {
                            const item = new ClipboardItem({ "image/png": blob });
                            await navigator.clipboard.write([item]);
                            alert("原稿用紙の画像をコピーしました！\nロイロノートや別ソフト of の画面で貼り付け（Ctrl + V）して提出してください。");
                            resolve();
                        } catch (clipErr) {
                            reject(clipErr);
                        }
                    } else {
                        reject(new Error("お使いのブラウザが画像のコピー機能に対応していません。"));
                    }
                }, "image/png");
            });
        } finally {
            $pages.show();
            $("body").css({"padding": ""});
            $(".genko").css({"padding": "", "margin": "", "justify-content": "", "width": ""});
            $(".genko-body").css({"margin": ""});
            $(".genko-paper").css({"margin": ""});
            $(".genko-paper.blank").show();
        }
    }

    onShareTwitterClicked(e) {
    }

    setWallpaper(key) {
        $("body").removeClass().addClass("skin-" + key);
    }

    setLightColor(val) {
        var ratio = Math.cos(val * Math.PI / 2 + Math.PI) + 1;
        $(".bg-lighting").css("background-color", `rgb(255, ${184 + 71 * ratio}, ${126 + 129 * ratio})`);
    }

    startProcessing(backdropClass) {
        return new Promise((resolve, reject) => {
            // すでに暗転画面が存在する場合は2重に作成しないように保護
            if (this.$backdrop || $("#processingBackdrop").length > 0) {
                resolve();
                return;
            }
            this.$backdrop = $(`<div id='processingBackdrop' class='modal-backdrop show ${backdropClass}'>`)
                    .appendTo(document.body);
            $(() => resolve());
        });
    }

    endProcessing() {
        setTimeout(() => {
            // DOM上のすべての暗転バックドロップを確実に削除
            const $b = $("#processingBackdrop");
            if ($b.length > 0) {
                $b.fadeOut(500, function() { $(this).remove(); });
            }
            this.$backdrop = null;
        });
    }

    onTimerSaving() {
        if (this.hasUnsavedChanges()) this.queueServerSave();
    }

    onClosing() {
        // 通信が終了処理に間に合わなくても、復旧用下書きは同期的に端末へ残る。
        this.persistRecoveryDraft();
        if (this.hasUnsavedChanges()) this.queueServerSave();
    }

    getPages() {
        return $(".genko-paper:not(.blank)");
    }

    getCurrentPrintData() {
        if (this.isDevMode) {
            return {
                classNumber: this.devStudent.classNumber,
                studentId: this.devStudent.studentId,
                studentName: this.devStudent.studentName,
                writingType: $("#writingTypeSelect").val() || "none",
                writingTitle: $("#writingTitleInput").val() || "",
                bookName: $("#bookNameInput").val() || "",
                teacherComment: this.currentTeacherComment
            };
        }

        const classNumber = window.localStorage.getItem("genko_classNumber");
        const studentId = window.localStorage.getItem("genko_studentId");
        const studentName = window.localStorage.getItem("genko_studentName");
        if (!classNumber || !studentId || !studentName) return null;

        const isTeacher = (studentId === "99" || studentId === 99);
        if (isTeacher) return this.currentPrintStudent;

        return {
            classNumber,
            studentId,
            studentName,
            writingType: $("#writingTypeSelect").val() || "none",
            writingTitle: $("#writingTitleInput").val() || "",
            bookName: $("#bookNameInput").val() || "",
            teacherComment: this.currentTeacherComment
        };
    }

    getCurrentSettingsSnapshot(isCompleted = false) {
        return {
            genkoSettings: {
                colSize: this.genko.colSize,
                rowSize: this.genko.rowSize,
                featuringColor: this.genko.featuringColor,
                featuringFont: this.genko.featuringFont,
                featuringFontRoman: this.genko.featuringFontRoman,
                cellOptions: this.genko.cellOptions,
                selectionStyle: this.genko.selectionStyle
            },
            appSettings: {
                wallpaper: this.settings.params.wallpaper,
                lightColor: this.settings.params.lightColor,
                showTeacherComment: this.settings.params.showTeacherComment !== false,
                showPrintFooter: this.settings.params.showPrintFooter !== false
            },
            isCompleted
        };
    }

    appendPrintFooters($papers, data) {
        $(".paper-print-footer").remove();
        $(".genko-paper").removeClass("has-print-footer");
        if (this.settings.params.showPrintFooter === false || !$papers || $papers.length === 0 || !data) return;

        const writingType = data.writingType || "none";
        const typeName = WRITING_TYPE_LABELS[writingType] || "作文";
        const isKansoubun = (writingType === "課題図書" || writingType === "自由図書");

        $papers.each(function(pageIndex) {
            let footerText = `${data.classNumber}組 ${data.studentId}番 ${data.studentName}　${typeName}`;
            if (isKansoubun && data.writingTitle) {
                footerText += `　題名：「${data.writingTitle}」`;
            }
            if (isKansoubun && data.bookName) {
                footerText += `　本の名前：「${data.bookName}」`;
            }
            footerText += `　${pageIndex + 1}/${$papers.length}`;

            $("<div>")
                .addClass("paper-print-footer")
                .text(footerText)
                .appendTo($(this).addClass("has-print-footer"));
        });
    }

    refreshScreenPrintDetails() {
        const $papers = this.getPages();
        const printData = this.getCurrentPrintData();
        this.appendPrintFooters($papers, printData);
        this.appendTeacherCommentToFirstPage($papers, printData?.teacherComment || "");
    }

    scheduleScreenPrintDetails() {
        if (this.printDetailsTimer) clearTimeout(this.printDetailsTimer);
        this.printDetailsTimer = setTimeout(() => this.refreshScreenPrintDetails(), 100);
    }

    setupPageDetailsObserver() {
        if (this.pageDetailsObserver) this.pageDetailsObserver.disconnect();

        const container = this.genko.$container && this.genko.$container.get(0);
        if (!container) return;

        this.pageDetailsObserver = new MutationObserver(mutations => {
            const paperChanged = mutations.some(mutation => {
                const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
                return changedNodes.some(node => node.nodeType === 1 && node.matches(".genko-paper"));
            });

            if (paperChanged) this.scheduleScreenPrintDetails();
        });
        this.pageDetailsObserver.observe(container, {childList: true});
    }

    setupDevelopmentMode() {
        const data = this.devStudent;

        $("body").addClass("development-mode");
        this.$dialogLogin.modal("hide");
        $("#login-display-class").text(`${data.classNumber}組　${data.studentId}番`);
        $("#login-display-name").text(`${data.studentName}（開発確認）`);
        $("#logoutBtn").hide();
        $("#writing-meta-container").removeClass("d-none");
        $("#controlPane, #sharePane").addClass("d-none");
        this.$teacherSidebar.addClass("d-none");
        $("body").removeClass("has-teacher-sidebar");
        this.$studentControlPanel.removeClass("d-none");

        this.genko.setReadOnly(false);
        $("#writingTypeSelect, #writingTitleInput, #bookNameInput").prop("disabled", false);
        $("#writingTypeSelect").val(data.writingType);
        this.updateWritingTypeUi(data.writingType);
        $("#writingTitleInput").val(data.writingTitle);
        $("#bookNameInput").val(data.bookName);
        this.genko.setText(data.text);
        this.genko.refresh();
        this.updateTeacherComment(data.teacherComment);
        this.refreshScreenPrintDetails();
        this.isCompletedStatus = false;
        this.updateCompleteButtonUi();
        this.updateSaveStatus("saved");

        const $toolbar = $("<aside>", {id: "dev-toolbar"});
        $("<div>")
            .addClass("dev-toolbar-title")
            .text("開発確認モード")
            .appendTo($toolbar);
        $("<div>")
            .addClass("dev-toolbar-note")
            .text("GASへの通信・保存は行いません。日付などが印刷される場合は、印刷画面の「詳細設定」→「ヘッダーとフッター」をオフにしてください")
            .appendTo($toolbar);
        $("<label>")
            .attr("for", "dev-teacher-comment")
            .text("印刷する先生のコメント")
            .appendTo($toolbar);

        const $commentInput = $("<textarea>", {
            id: "dev-teacher-comment",
            class: "form-control",
            rows: 5
        })
            .val(data.teacherComment)
            .on("input", e => this.updateTeacherComment($(e.currentTarget).val()))
            .appendTo($toolbar);

        const $actions = $("<div>").addClass("dev-toolbar-actions").appendTo($toolbar);
        $("<button>", {type: "button", class: "btn btn-danger"})
            .html('<i class="fa fa-print"></i> 印刷プレビュー')
            .click(() => window.print())
            .appendTo($actions);
        $("<button>", {type: "button", class: "btn btn-outline-secondary"})
            .text("コメントを空にする")
            .click(() => $commentInput.val("").trigger("input"))
            .appendTo($actions);
        $("<button>", {type: "button", class: "btn btn-outline-primary"})
            .text("サンプルに戻す")
            .click(() => {
                $commentInput.val(data.teacherComment).trigger("input");
                $("#writingTypeSelect").val(data.writingType);
                this.updateWritingTypeUi(data.writingType);
                $("#writingTitleInput").val(data.writingTitle);
                $("#bookNameInput").val(data.bookName);
                this.genko.setText(data.text);
                this.genko.refresh();
                this.scheduleScreenPrintDetails();
            })
            .appendTo($actions);

        $toolbar.appendTo(document.body);
    }

    appendTeacherCommentToFirstPage($papers, comment) {
        $(".paper-print-comment").remove();

        const normalizedComment = (comment || "").toString().trim();
        if (this.settings.params.showTeacherComment === false || !$papers || $papers.length === 0 || !normalizedComment) return;

        $("<div>")
            .addClass("paper-print-comment")
            .text(`先生から：${normalizedComment}`)
            .appendTo($papers.first());
    }

    async checkLoginStatus() {
        const classNum = window.localStorage.getItem("genko_classNumber");
        const studentId = window.localStorage.getItem("genko_studentId");
        const studentName = window.localStorage.getItem("genko_studentName");

        if (classNum && studentId && studentName) {
            $("#login-display-class").text(classNum + "組　" + studentId + "番");
            $("#login-display-name").text(studentName);
            $("#writing-meta-container").removeClass("d-none"); // ログイン時に表示
            
            // 教師用メニューの表示制御 (出席番号「99」を教師用とする)
            if (studentId === "99" || studentId === 99) {
                this.genko.setReadOnly(true); // 教師画面では児童作文の誤書き換えを防ぐためエディタを読み取り専用に
                $("#writingTypeSelect, #writingTitleInput, #bookNameInput").prop("disabled", true); // 教師用画面では作文の種類・題名・本の名前も変更不可に
                this.$studentControlPanel.addClass("d-none"); // 先生用画面では非表示
                $("#controlPane, #sharePane").removeClass("d-none"); // 設定・共有タブを表示
                $(".teacher-only-setting").removeClass("d-none");
                // 設定変更を許可する
                $("#controlPane").find("input, select, .size-preset button, #colorPalette button, #selectionStyleColors button").prop("disabled", false);
                
                // 教師自身の保存されている設定データをロードして適用
                await this.loadTeacherSettingsFromServer();

                // 先生用ワークスペースの初期化（サイドバーを構築）
                await this.initTeacherWorkspace(classNum);
            } else {
                this.genko.setReadOnly(false); // 児童画面では書き込み可能に
                $("#writingTypeSelect, #writingTitleInput, #bookNameInput").prop("disabled", false); // 児童用画面では作文の種類・題名・本の名前も変更可能に
                this.$teacherSidebar.addClass("d-none");
                $("body").removeClass("has-teacher-sidebar");
                this.$studentControlPanel.removeClass("d-none"); // 児童用画面では表示
                $("#controlPane, #sharePane").addClass("d-none"); // 児童画面では設定・共有タブを非表示に！
                $(".teacher-only-setting").addClass("d-none");
                // 児童は設定を変更できないように一部コントロールを無効化
                $("#controlPane").find("input, select, .size-preset button, #colorPalette button, #selectionStyleColors button").prop("disabled", true);
                this.updateSaveStatus("saved");
            }
            
            this.$dialogLogin.modal("hide");
        } else {
            this.genko.setReadOnly(false); // ゲスト状態でもお試し入力できるように書き込み可能に
            $("#writingTypeSelect, #writingTitleInput").prop("disabled", false); // ゲスト状態でも変更可能に
            $("#login-display-class").text("未ログイン");
            $("#login-display-name").text("ゲスト");
            this.$teacherSidebar.addClass("d-none");
            $("body").removeClass("has-teacher-sidebar");
            this.$studentControlPanel.addClass("d-none"); // 未ログイン時は非表示
            $("#controlPane, #sharePane").removeClass("d-none"); // ログイン前は表示
            $("#writing-meta-container").addClass("d-none"); // 未ログイン時は非表示
            $(".teacher-only-setting").addClass("d-none");
            this.$dialogLogin.modal("show");
            // 未ログインの場合、サーバーから児童名簿を読み込む
            await this.loadStudentRoster();
        }
    }

    async onLoginSubmitted(e) {
        e.preventDefault();
        const classNum = this.$loginClassNum.val();
        const studentSelectVal = this.$loginStudentSelect.val(); // 出席番号（studentId）
        
        let password = (this.$loginPassword.val() || "").toString();
        // 児童が全角でパスワードを入力した場合を考慮し、全角英数字を半角に自動変換する
        password = password.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(s) {
            return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
        }).trim();

        if (classNum && studentSelectVal && password) {
            const studentId = studentSelectVal;

            await this.startProcessing("backdrop-loading");
            try {
                const response = await fetchWithRetry(GAS_URL, {
                    method: "POST",
                    mode: "cors",
                    headers: {
                        "Content-Type": "text/plain"
                    },
                    body: JSON.stringify({
                        action: "login",
                        classNumber: classNum,
                        studentId: studentId,
                        password: password
                    })
                });
                const res = await response.json();
                if (res.status === "success") {
                    if (!res.sessionToken) {
                        throw new Error("安全なログイン情報を受け取れませんでした。");
                    }

                    const studentName = res.studentName || `${studentId}番`;

                    // GASが発行した短時間の入場券だけを、このタブを閉じるまで保持する
                    window.sessionStorage.setItem(SESSION_TOKEN_KEY, res.sessionToken);
                    window.localStorage.setItem("genko_classNumber", classNum);
                    window.localStorage.setItem("genko_studentId", studentId);
                    window.localStorage.setItem("genko_studentName", studentName);
                    // パスワードはオートフィルせず毎回手入力させるため、保存しないように変更しました
                    $("#login-error").addClass("d-none");
                    await this.checkLoginStatus();

                    // パスワード入力欄をクリア
                    this.$loginPassword.val("");

                    if (studentId === "99" || studentId === 99) {
                        // 先生ログイン時も、設定データがあれば読み込んで適用する
                        if (res.data && res.data.settings) {
                            try {
                                const parsedSettings = JSON.parse(res.data.settings);
                                this.settings.apply(parsedSettings.genkoSettings, parsedSettings.appSettings);
                            } catch (err) {
                                console.error("設定パースエラー:", err);
                            }
                        }
                    } else {
                        // 児童ログイン時は通常の個別読み込み
                        if (res.data) {
                            const data = res.data;
                            if (data.settings) {
                                try {
                                    const parsedSettings = JSON.parse(data.settings);
                                    this.settings.apply(parsedSettings.genkoSettings, parsedSettings.appSettings);
                                    
                                    // できた！(完成)ステータスのロードとUI反映
                                    if (parsedSettings.isCompleted !== undefined) {
                                        this.isCompletedStatus = !!parsedSettings.isCompleted;
                                    } else {
                                        this.isCompletedStatus = false;
                                    }
                                    this.updateCompleteButtonUi();
                                } catch (err) {
                                    console.error("設定パースエラー:", err);
                                    this.isCompletedStatus = false;
                                    this.updateCompleteButtonUi();
                                }
                            } else {
                                this.isCompletedStatus = false;
                                this.updateCompleteButtonUi();
                            }

                            // 作文の種類と題名のロードとUI反映
                            const wType = data.writingType || "none";
                            $("#writingTypeSelect").val(wType);
                            this.updateWritingTypeUi(wType);

                            if (data.writingTitle) {
                                $("#writingTitleInput").val(data.writingTitle);
                            } else {
                                $("#writingTitleInput").val("");
                            }

                            if (data.bookName) {
                                $("#bookNameInput").val(data.bookName);
                            } else {
                                $("#bookNameInput").val("");
                            }

                            // 空の作文でも必ず反映し、ログイン前に入力したゲスト文章を残さない。
                            this.genko.setText(data.text || "");
                            this.genko.refresh();
                            
                            // 先生からのアドバイスを表示・制御する
                            this.updateTeacherComment(data.teacherComment || "");
                            
                            console.log("スプレッドシートからの作文データのロードに成功しました");
                        } else {
                            this.genko.clear();
                            this.isCompletedStatus = false;
                            this.updateCompleteButtonUi();
                            this.updateTeacherComment("");
                            console.log("新規作文の作成を開始します");
                        }

                        this.resetSaveTracking();
                        const restored = this.restoreRecoveryDraft(classNum, studentId, res.data || null);
                        if (restored) {
                            await this.triggerAutoSaveToServer(true);
                        } else {
                            this.updateSaveStatus("saved");
                        }
                        this.scheduleScreenPrintDetails();
                    }
                } else {
                    $("#login-error").text(res.message || "ログインに失敗しました。").removeClass("d-none");
                }
            } catch (err) {
                console.error("ログイン認証エラー:", err);
                $("#login-error").text("サーバーとの通信に失敗しました。").removeClass("d-none");
            } finally {
                this.endProcessing();
            }
        } else {
            $("#login-error").text("入力項目に誤りがあります。").removeClass("d-none");
        }
    }

    async onLogoutClicked(e) {
        e.preventDefault();
        if (confirm("別の人でログインし直しますか？\n（現在の作文データはそのまま残ります）")) {
            const saved = await this.flushPendingSave();
            if (!saved && !confirm("最新の内容をサーバーへ保存できませんでした。端末には復旧用の下書きが残っています。\nこのままログアウトしますか？")) {
                return;
            }

            const sessionToken = getSessionToken();
            if (sessionToken) {
                try {
                    await fetch(GAS_URL, {
                        method: "POST",
                        mode: "cors",
                        headers: {"Content-Type": "text/plain"},
                        body: JSON.stringify({action: "logout", sessionToken})
                    });
                } catch (err) {
                    console.warn("サーバー側のログアウト処理を完了できませんでした:", err);
                }
            }

            // 教師用サイドバーと余白スタイルを解除
            this.$teacherSidebar.empty().addClass("d-none");
            $("body").removeClass("has-teacher-sidebar");
            this.currentPrintStudent = null;

            window.localStorage.removeItem("genko_classNumber");
            window.localStorage.removeItem("genko_studentId");
            window.localStorage.removeItem("genko_studentName");
            window.localStorage.removeItem("genko_password"); // パスワードもクリア
            window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
            this.$loginClassNum.val("");
            this.$loginStudentSelect.val("").prop("disabled", true);
            this.$loginPassword.val("");
            this.updateTeacherComment("");
            this.$studentControlPanel.addClass("d-none");
            $("#controlPane, #sharePane").removeClass("d-none"); // ログアウト後は再表示
            $("#writingTypeSelect").val("none");
            this.updateWritingTypeUi("none");
            $("#writingTitleInput").val("");
            $("#bookNameInput").val("");
            $("#writing-meta-container").addClass("d-none");
            // 設定無効化を解除（ゲスト状態なので一応有効に）
            $("#controlPane").find("input, select, .size-preset button, #colorPalette button, #selectionStyleColors button").prop("disabled", false);
            $(".paper-print-footer").remove();
            $(".genko-paper").removeClass("has-print-footer");

            // エディタをクリア
            this.genko.clear();
            this.isCompletedStatus = false;
            this.updateCompleteButtonUi();
            this.resetSaveTracking();

            await this.checkLoginStatus();
        }
    }

    onInputChanged(e) {
        this.updateSaveStatus("dirty");
        this.triggerAutoSaveToServer();
        this.scheduleScreenPrintDetails();
    }

    getLoggedInIdentity() {
        const classNumber = window.localStorage.getItem("genko_classNumber") || "";
        const studentId = window.localStorage.getItem("genko_studentId") || "";
        const studentName = window.localStorage.getItem("genko_studentName") || "";
        if (!classNumber || !studentId || !studentName) return null;
        return {
            classNumber,
            studentId,
            studentName,
            isTeacher: studentId === "99"
        };
    }

    getRecoveryDraftKey(classNumber, studentId) {
        return `${RECOVERY_DRAFT_PREFIX}${classNumber}:${studentId}`;
    }

    createSaveSnapshot() {
        const identity = this.getLoggedInIdentity();
        if (!identity) return null;

        const text = identity.isTeacher ? "" : this.genko.getText();
        const settingsData = this.getCurrentSettingsSnapshot(identity.isTeacher ? false : this.isCompletedStatus);
        return {
            ...identity,
            text,
            charCount: text.length,
            settings: identity.isTeacher ? JSON.stringify(settingsData) : "",
            isCompleted: identity.isTeacher ? false : this.isCompletedStatus,
            writingType: identity.isTeacher ? "none" : ($("#writingTypeSelect").val() || "none"),
            writingTitle: identity.isTeacher ? "" : ($("#writingTitleInput").val() || ""),
            bookName: identity.isTeacher ? "" : ($("#bookNameInput").val() || "")
        };
    }

    persistRecoveryDraft(snapshot = null) {
        const data = snapshot || this.createSaveSnapshot();
        if (!data || data.isTeacher || !this.hasUnsavedChanges()) return;

        try {
            window.localStorage.setItem(
                this.getRecoveryDraftKey(data.classNumber, data.studentId),
                JSON.stringify({
                    text: data.text,
                    isCompleted: data.isCompleted,
                    writingType: data.writingType,
                    writingTitle: data.writingTitle,
                    bookName: data.bookName,
                    updatedAt: new Date().toISOString()
                })
            );
        } catch (err) {
            console.warn("復旧用下書きを端末へ保存できませんでした:", err);
        }
    }

    clearRecoveryDraft(classNumber, studentId) {
        try {
            window.localStorage.removeItem(this.getRecoveryDraftKey(classNumber, studentId));
        } catch (err) {
            console.warn("復旧用下書きを削除できませんでした:", err);
        }
    }

    restoreRecoveryDraft(classNumber, studentId, serverData) {
        const key = this.getRecoveryDraftKey(classNumber, studentId);
        let draft;
        try {
            const raw = window.localStorage.getItem(key);
            if (!raw) return false;
            draft = JSON.parse(raw);
        } catch (err) {
            window.localStorage.removeItem(key);
            return false;
        }

        const serverSettings = (() => {
            try {
                return serverData && serverData.settings ? JSON.parse(serverData.settings) : {};
            } catch (err) {
                return {};
            }
        })();
        const serverCompleted = !!serverSettings.isCompleted;
        const sameAsServer = (draft.text || "") === ((serverData && serverData.text) || "")
            && (draft.writingType || "none") === ((serverData && serverData.writingType) || "none")
            && (draft.writingTitle || "") === ((serverData && serverData.writingTitle) || "")
            && (draft.bookName || "") === ((serverData && serverData.bookName) || "")
            && !!draft.isCompleted === serverCompleted;

        if (sameAsServer) {
            this.clearRecoveryDraft(classNumber, studentId);
            return false;
        }

        if (!confirm("前回、サーバーへ送信できなかった作文がこの端末に残っています。\n復元しますか？")) {
            this.clearRecoveryDraft(classNumber, studentId);
            return false;
        }

        this.genko.setText(draft.text || "");
        this.genko.refresh();
        this.isCompletedStatus = !!draft.isCompleted;
        this.updateCompleteButtonUi();
        const writingType = draft.writingType || "none";
        $("#writingTypeSelect").val(writingType);
        this.updateWritingTypeUi(writingType);
        $("#writingTitleInput").val(draft.writingTitle || "");
        $("#bookNameInput").val(draft.bookName || "");
        this.updateSaveStatus("dirty");
        return true;
    }

    resetSaveTracking() {
        if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = null;
        this.saveRequested = false;
        this.contentRevision = 0;
        this.lastSavedRevision = 0;
    }

    hasUnsavedChanges() {
        return this.contentRevision > this.lastSavedRevision || this.saveRequested;
    }

    async flushPendingSave() {
        if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = null;
        if (this.savePromise) return this.savePromise;
        if (!this.hasUnsavedChanges()) return true;
        return this.queueServerSave();
    }

    triggerAutoSaveToServer(immediate = false) {
        if (this.isDevMode) {
            this.updateSaveStatus("saved");
            return Promise.resolve(true);
        }

        if (!this.getLoggedInIdentity()) return Promise.resolve(false);
        this.contentRevision += 1;
        this.persistRecoveryDraft();

        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
        }
        this.autoSaveTimer = null;

        if (immediate) {
            return this.queueServerSave();
        } else {
            this.autoSaveTimer = setTimeout(() => {
                this.autoSaveTimer = null;
                this.queueServerSave();
            }, 10000); // 通常はタイピング停止後10秒で保存
            return Promise.resolve(true);
        }
    }

    queueServerSave() {
        this.saveRequested = true;
        if (this.savePromise) return this.savePromise;

        this.savePromise = (async () => {
            let allSuccessful = true;

            while (this.saveRequested) {
                this.saveRequested = false;
                const snapshot = this.createSaveSnapshot();
                if (!snapshot) return false;
                const revision = this.contentRevision;

                if (!snapshot.isTeacher) this.updateSaveStatus("saving");

                try {
                    const response = await fetchWithRetry(GAS_URL, {
                        method: "POST",
                        mode: "cors",
                        headers: {"Content-Type": "text/plain"},
                        body: JSON.stringify(withSession({
                            action: "save",
                            classNumber: snapshot.classNumber,
                            studentId: snapshot.studentId,
                            studentName: snapshot.studentName,
                            charCount: snapshot.charCount,
                            text: snapshot.text,
                            settings: snapshot.settings,
                            isCompleted: snapshot.isCompleted,
                            writingType: snapshot.writingType,
                            writingTitle: snapshot.writingTitle,
                            bookName: snapshot.bookName
                        }))
                    });
                    const res = await response.json();
                    if (res.status !== "success") {
                        throw new Error(res.message || "保存できませんでした。");
                    }

                    this.lastSavedRevision = Math.max(this.lastSavedRevision, revision);
                    console.log("スプレッドシートへの保存に成功しました");

                    if (this.contentRevision === revision && !this.saveRequested) {
                        this.clearRecoveryDraft(snapshot.classNumber, snapshot.studentId);
                        if (!snapshot.isTeacher) this.updateSaveStatus("saved");
                    } else {
                        this.saveRequested = true;
                        if (!snapshot.isTeacher) this.updateSaveStatus("dirty");
                    }
                } catch (err) {
                    allSuccessful = false;
                    this.persistRecoveryDraft();
                    console.error("保存エラー:", err);
                    if (!snapshot.isTeacher) this.updateSaveStatus("error");
                    break;
                }
            }

            return allSuccessful;
        })().finally(() => {
            this.savePromise = null;
            // 完了直前に新しい変更が入った場合も、次の保存を取りこぼさない。
            if (this.saveRequested) this.queueServerSave();
        });

        return this.savePromise;
    }

    async loadStudentRoster() {
        try {
            const response = await fetchWithRetry(GAS_URL, {
                method: "POST",
                mode: "cors",
                headers: {
                    "Content-Type": "text/plain"
                },
                body: JSON.stringify({
                    action: "get_students"
                })
            });
            const res = await response.json();
            if (res.status === "success") {
                this.studentRoster = res.data;
                
                // クラスセレクトボックスを初期化して充填
                this.$loginClassNum.empty().append(
                    $("<option>").val("").text("クラス（半角数字）を選択してください").prop("disabled", true).prop("selected", true)
                );
                this.$loginStudentSelect.empty().append(
                    $("<option>").val("").text("先にクラスを選択してください").prop("disabled", true).prop("selected", true)
                ).prop("disabled", true);
                
                const classes = Object.keys(this.studentRoster);
                if (classes.length === 0) {
                    $("#login-error").text("名簿データがスプレッドシートに登録されていません。").removeClass("d-none");
                    return;
                }
                
                classes.forEach(c => {
                    this.$loginClassNum.append($("<option>").val(c).text(c));
                });

                // 一人一台端末向け：前回のログイン情報をオートフィル
                const lastClass = window.localStorage.getItem("genko_classNumber");
                const lastStudent = window.localStorage.getItem("genko_studentId");

                if (lastClass && this.studentRoster[lastClass]) {
                    this.$loginClassNum.val(lastClass);
                    this.onClassNumChanged(); // 出席番号の選択肢を生成して有効化
                    
                    if (lastStudent) {
                        this.$loginStudentSelect.val(lastStudent);
                    }
                }


                $("#login-error").addClass("d-none");
            } else {
                $("#login-error").text("名簿データの取得に失敗しました。").removeClass("d-none");
            }
        } catch (err) {
            console.error("名簿データの取得エラー:", err);
            $("#login-error").text("サーバーとの通信に失敗しました。オフライン状態か、または設定が正しくない可能性があります。").removeClass("d-none");
        }
    }

    onClassNumChanged(e) {
        const selectedClass = this.$loginClassNum.val();
        this.$loginStudentSelect.empty();
        
        if (!selectedClass || !this.studentRoster || !this.studentRoster[selectedClass]) {
            this.$loginStudentSelect.append(
                $("<option>").val("").text("先にクラスを選択してください").prop("disabled", true).prop("selected", true)
            ).prop("disabled", true);
            return;
        }
        
        this.$loginStudentSelect.append(
            $("<option>").val("").text("出席番号を選択してください").prop("disabled", true).prop("selected", true)
        ).prop("disabled", false);
        
        const students = this.studentRoster[selectedClass];
        students.forEach(student => {
            const val = student.id;
            const text = `${student.id}番`;
            this.$loginStudentSelect.append($("<option>").val(val).text(text));
        });
    }

    async onTeacherExportPdfClicked(e) {
        e.preventDefault();

        const classNumber = window.localStorage.getItem("genko_classNumber");
        const studentId = window.localStorage.getItem("genko_studentId");
        if (!classNumber || (studentId !== "99" && studentId !== 99)) return;

        // クリック直後に開いておくことで、ブラウザのポップアップ制限を避ける
        const printWindow = window.open("about:blank", "_blank");
        if (!printWindow) {
            alert("一括印刷画面を開けませんでした。ブラウザのポップアップを許可してから、もう一度お試しください。");
            return;
        }

        printWindow.document.title = "全員分の印刷を準備中";
        printWindow.document.body.innerHTML = '<p style="font-family:sans-serif;padding:30px;font-size:18px;">全員分の作文を準備しています…</p>';

        const $button = $(e.currentTarget);
        const originalButtonHtml = $button.html();
        $button.prop("disabled", true).html('<i class="fa fa-spinner fa-spin"></i> 準備中…');

        try {
            const response = await fetchWithRetry(GAS_URL, {
                method: "POST",
                mode: "cors",
                headers: {
                    "Content-Type": "text/plain"
                },
                body: JSON.stringify(withSession({
                    action: "get_all_writings",
                    classNumber
                }))
            });
            const res = await response.json();
            if (res.status !== "success" || !Array.isArray(res.data)) {
                throw new Error("作文データを取得できませんでした。");
            }

            const writings = res.data
                .filter(w => w.studentId != 99 && (w.text || "").toString().trim() !== "")
                .sort((a, b) => String(a.studentId).localeCompare(String(b.studentId), "ja", {numeric: true}))
                .map(w => {
                    let isCompleted = false;
                    if (w.settings) {
                        try {
                            isCompleted = !!JSON.parse(w.settings).isCompleted;
                        } catch (err) {}
                    }

                    return {
                        ...w,
                        classNumber: w.classNumber || classNumber,
                        settings: JSON.stringify(this.getCurrentSettingsSnapshot(isCompleted))
                    };
                });

            if (writings.length === 0) {
                printWindow.close();
                alert("まだ作文が入力されている児童はいません。");
                return;
            }

            window.printData = writings;
            printWindow.location.replace(new URL("print.html", window.location.href).href);
        } catch (err) {
            printWindow.close();
            console.error("全員分の一括印刷エラー:", err);
            alert("全員分の印刷準備に失敗しました。少し待ってから、もう一度お試しください。\n\n詳細: " + err.message);
        } finally {
            $button.prop("disabled", false).html(originalButtonHtml);
        }
    }

    async initTeacherWorkspace(classNum) {
        this.$teacherSidebar.empty().removeClass("d-none");
        $("body").addClass("has-teacher-sidebar");

        await this.startProcessing("backdrop-loading");

        try {
            // 名簿データがまだロードされていない場合はロードする (リロード対策)
            if (!this.studentRoster) {
                await this.loadStudentRoster();
            }

            // 各児童の提出状況（誰が作文を書いているか、完成しているか）を色分けするため、一括ステータスをロード
            const response = await fetchWithRetry(GAS_URL, {
                method: "POST",
                mode: "cors",
                headers: {
                    "Content-Type": "text/plain"
                },
                body: JSON.stringify(withSession({
                    action: "get_all_writings",
                    classNumber: classNum
                }))
            });
            const res = await response.json();
            const writings = (res.status === "success" && res.data) ? res.data : [];

            const printableCount = writings.filter(w => w.studentId != 99 && (w.text || "").toString().trim() !== "").length;
            const $batchPanel = $("<div>").addClass("teacher-batch-print-panel");
            $("<button>", {type: "button", class: "btn btn-warning"})
                .html(`<i class="fa fa-file-pdf-o"></i> 全員分PDF・一括印刷（${printableCount}人）`)
                .prop("disabled", printableCount === 0)
                .click(this.onTeacherExportPdfClicked.bind(this))
                .appendTo($batchPanel);
            $("<small>")
                .addClass("teacher-batch-print-note")
                .text("作文が入力されている児童全員を、出席番号順に1つの印刷画面へまとめます。")
                .appendTo($batchPanel);
            $batchPanel.appendTo(this.$teacherSidebar);

            // クラス名簿を取得
            const students = this.studentRoster[classNum] || [];
            students.forEach(s => {
                if (s.id !== 99 && s.id !== "99") {
                    const w = writings.find(item => item.studentId == s.id);
                    const hasWriting = (w && w.text && w.text.trim() !== "");
                    const studentName = (w && w.studentName) ? w.studentName : `${s.id}番`;
                    
                    // できた！(完成)フラグの判定
                    let isCompleted = false;
                    if (w && w.settings) {
                        try {
                            const parsed = JSON.parse(w.settings);
                            isCompleted = !!parsed.isCompleted;
                        } catch(e){}
                    }

                    // 1. 左端の固定サイドバー用リストボタンの生成
                    const $btn = $("<button>")
                        .addClass("student-list-item")
                        .attr("data-student-id", s.id)
                        .click(() => this.selectTeacherStudent(s.id));
                    
                    const $infoSpan = $("<span>").text(`${s.id}番 ${studentName}`);
                    const $badge = $("<span>").addClass("student-status-badge");
                    if (isCompleted) {
                        $badge.addClass("completed").html('<i class="fa fa-check"></i> できた！');
                    } else if (hasWriting) {
                        $badge.addClass("writing").text("書きかけ");
                    } else {
                        $badge.addClass("empty").text("未入力");
                    }

                    $btn.append($infoSpan).append($badge).appendTo(this.$teacherSidebar);
                }
            });

        } catch (err) {
            console.error("先生用サイドバー初期化エラー:", err);
        } finally {
            this.endProcessing();
        }
    }

    async selectTeacherStudent(studentId) {
        const selectionRevision = ++this.teacherSelectionRevision;

        // サイドバーボタンのアクティブ表示切替
        this.$teacherSidebar.find(".student-list-item").removeClass("active");
        if (studentId) {
            this.$teacherSidebar.find(`.student-list-item[data-student-id="${studentId}"]`).addClass("active");
        }

        $(".paper-print-footer, .paper-print-comment").remove(); // 古い印刷用情報を削除
        this.currentPrintStudent = null;

        if (!studentId) {
            this.genko.clear();
            return;
        }

        await this.startProcessing("backdrop-loading");

        try {
            const classNum = window.localStorage.getItem("genko_classNumber");
            
            // 指定された児童1人分の「最新」の作文データをGASから直接フェッチ
            const response = await fetchWithRetry(GAS_URL, {
                method: "POST",
                mode: "cors",
                headers: {
                    "Content-Type": "text/plain"
                },
                body: JSON.stringify(withSession({
                    action: "get_student_writing",
                    classNumber: classNum,
                    studentId: studentId
                }))
            });
            const res = await response.json();

            // 連続して児童を選んだ場合、先に選んだ児童の遅い応答で画面を戻さない。
            if (selectionRevision !== this.teacherSelectionRevision) return;

            if (res.status === "success" && res.data) {
                const w = res.data;
                this.currentPrintStudent = w;
                
                // 設定の適用
                if (w.settings) {
                    try {
                        const parsedSettings = JSON.parse(w.settings);
                        // 先生画面の印刷表示設定は、児童を切り替えても現在の選択を維持する。
                        // 通信中の保存より古い設定が返ってきても、コメントやフッターを消さない。
                        const currentPrintPreferences = {
                            showTeacherComment: this.settings.params.showTeacherComment !== false,
                            showPrintFooter: this.settings.params.showPrintFooter !== false
                        };
                        this.settings.apply(parsedSettings.genkoSettings, {
                            ...(parsedSettings.appSettings || {}),
                            ...currentPrintPreferences
                        });
                    } catch (err) {
                        console.error("設定適用エラー:", err);
                    }
                } else {
                    this.genko.clear();
                }

                // 作文の種類と題名の反映
                const wType = w.writingType || "none";
                $("#writingTypeSelect").val(wType);
                this.updateWritingTypeUi(wType);

                if (w.writingTitle) {
                    $("#writingTitleInput").val(w.writingTitle);
                } else {
                    $("#writingTitleInput").val("");
                }

                if (w.bookName) {
                    $("#bookNameInput").val(w.bookName);
                } else {
                    $("#bookNameInput").val("");
                }

                // 作文本文の反映
                this.genko.setText(w.text || "");
                this.genko.refresh();
                
                // アドバイスの反映
                this.updateTeacherComment(w.teacherComment || "");
                
                // 児童用画面と同じ共通処理で、画面上にも印刷用フッターを表示
                this.scheduleScreenPrintDetails();

                console.log(`${studentId}番の最新作文データを表示しました`);
            } else {
                this.genko.clear();
                alert("この児童の保存された作文データはありません。");
            }
        } catch (err) {
            console.error("児童作文データのロードエラー:", err);
            alert("作文データの取得中にエラーが発生しました。\nネットワーク接続が一時的に不安定か、サーバー（GAS）が非常に混み合っている可能性があります。\n少し時間をおいてもう一度お試しください。\n\n詳細: " + err.message);
        } finally {
            this.endProcessing();
        }
    }

    async loadTeacherSettingsFromServer() {
        const classNum = window.localStorage.getItem("genko_classNumber");
        const studentId = window.localStorage.getItem("genko_studentId");
        
        if (!classNum || (studentId !== "99" && studentId !== 99)) return;
        
        try {
            const response = await fetchWithRetry(GAS_URL, {
                method: "POST",
                mode: "cors",
                headers: {
                    "Content-Type": "text/plain"
                },
                body: JSON.stringify(withSession({
                    action: "load",
                    classNumber: classNum,
                    studentId: studentId
                }))
            });
            const res = await response.json();
            if (res.status === "success" && res.data && res.data.settings) {
                const parsedSettings = JSON.parse(res.data.settings);
                this.settings.apply(parsedSettings.genkoSettings, parsedSettings.appSettings);
                console.log("教師の設定データをスプレッドシートから読み込み、適用しました");
            }
        } catch (err) {
            console.error("教師設定ロードエラー:", err);
        }
    }

    onCompleteToggleClicked(e) {
        e.preventDefault();
        
        // できた！ステータスをトグル
        this.isCompletedStatus = !this.isCompletedStatus;
        this.updateCompleteButtonUi();

        // 状態変更を即座にサーバー（GAS）へ保存して同期
        this.triggerAutoSaveToServer(true);
    }

    updateCompleteButtonUi() {
        if (this.isCompletedStatus) {
            this.$completeBtn
                .removeClass("btn-secondary")
                .addClass("btn-success")
                .html('<i class="fa fa-check-circle fa-lg"></i><strong>できた！</strong>');
        } else {
            this.$completeBtn
                .removeClass("btn-success")
                .addClass("btn-secondary")
                .html('<i class="fa fa-smile-o fa-lg"></i><strong>まだだよ</strong>');
        }
    }

    onSaveStatusBtnClicked(e) {
        e.preventDefault();
        this.triggerAutoSaveToServer(true);
    }

    updateSaveStatus(status) {
        this.saveStatus = status;
        const $btn = this.$saveStatusBtn;
        
        if (status === "saved") {
            $btn.removeClass("btn-primary btn-warning btn-danger")
                .addClass("btn-outline-success")
                .css("background-color", "white")
                .html('<i class="fa fa-check-circle fa-lg"></i><strong>保存済み</strong>');
            $btn.prop("disabled", false);
        } else if (status === "dirty") {
            $btn.removeClass("btn-outline-success btn-warning btn-danger")
                .addClass("btn-primary")
                .css("background-color", "")
                .html('<i class="fa fa-cloud-upload fa-lg"></i><strong>保存する</strong>');
            $btn.prop("disabled", false);
        } else if (status === "saving") {
            $btn.removeClass("btn-outline-success btn-primary btn-danger")
                .addClass("btn-warning")
                .css("background-color", "")
                .html('<i class="fa fa-spinner fa-spin fa-lg"></i><strong>保存中...</strong>');
            $btn.prop("disabled", true);
        } else if (status === "error") {
            $btn.removeClass("btn-outline-success btn-primary btn-warning")
                .addClass("btn-danger")
                .css("background-color", "")
                .html('<i class="fa fa-exclamation-triangle fa-lg"></i><strong>保存失敗</strong>');
            $btn.prop("disabled", false);
        }
    }

    updateTeacherComment(comment) {
        const hasComment = comment && comment.trim() !== "";
        this.currentTeacherComment = hasComment ? comment : "";

        this.appendTeacherCommentToFirstPage(this.getPages(), this.currentTeacherComment);
    }

    onWritingTypeChanged(e) {
        const nextVal = $(e.target).val();
        this.updateWritingTypeUi(nextVal);
        this.triggerAutoSaveToServer(true);
        this.scheduleScreenPrintDetails();
    }

    updateWritingTypeUi(type) {
        if (type === "課題図書" || type === "自由図書") {
            $("#writing-title-wrapper, #book-name-wrapper").removeClass("d-none");
        } else {
            $("#writing-title-wrapper, #book-name-wrapper").addClass("d-none");
            $("#writingTitleInput").val(""); // 題名をクリア
            $("#bookNameInput").val(""); // 本の名前をクリア
        }
    }
}

$(() => new Main().setup());
