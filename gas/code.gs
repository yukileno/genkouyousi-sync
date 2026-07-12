function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var action = params.action || "save";
    
    // 名簿シート（またはアクティブな最初のシート）を取得します
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("名簿") 
                || SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    
    // もしシートが完全に空の場合は、初期ヘッダーを設定する（念のため）
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["クラス", "出席番号", "氏名", "パスワード", "最終保存日時", "文字数", "本文", "設定データ"]);
    }
    
    if (action === "save") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      var charCount = params.charCount;
      var text = params.text;
      var settings = params.settings;
      var timestamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm");
      
      var data = sheet.getDataRange().getValues();
      var foundRow = -1;
      
      // 登録されている児童の行を検索 (A列=クラス, B列=出席番号)
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          foundRow = i + 1; // 1-based index
          break;
        }
      }
      
      if (foundRow > 0) {
        // 同じ行の右側に作文データを上書き保存
        sheet.getRange(foundRow, 5).setValue(timestamp); // E列: 保存日時
        sheet.getRange(foundRow, 6).setValue(charCount); // F列: 文字数
        sheet.getRange(foundRow, 7).setValue(text);      // G列: 本文
        sheet.getRange(foundRow, 8).setValue(settings);  // H列: 設定
        
        return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
          .setMimeType(ContentService.MimeType.JSON);
      } else {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "児童が名簿に登録されていません" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
    } else if (action === "load") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      
      var data = sheet.getDataRange().getValues();
      var result = null;
      
      // クラスの教師(99番)の設定データを取得
      var teacherSettings = null;
      for (var j = 1; j < data.length; j++) {
        if (normalizeClass(data[j][0]) == classNumber && (data[j][1] == 99 || data[j][1] == "99")) {
          teacherSettings = data[j][7] || null;
          break;
        }
      }
      
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          result = {
            classNumber: data[i][0],
            studentId: data[i][1],
            studentName: data[i][2],
            charCount: data[i][5] || 0,
            text: data[i][6] || "",
            settings: teacherSettings // 教師の設定を優先適用
          };
          break;
        }
      }
      
      if (result) {
        return ContentService.createTextOutput(JSON.stringify({ status: "success", data: result }))
          .setMimeType(ContentService.MimeType.JSON);
      } else {
        return ContentService.createTextOutput(JSON.stringify({ status: "not_found" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
    } else if (action === "get_students") {
      var data = sheet.getDataRange().getValues();
      var students = {};
      
      // 1行目はヘッダー [クラス, 出席番号, 氏名, パスワード, ...]
      for (var i = 1; i < data.length; i++) {
        var classNum = normalizeClass(data[i][0]);
        var studentId = data[i][1] ? parseInt(data[i][1]) : null;
        
        if (!classNum || !studentId) continue;
        
        if (!students[classNum]) {
          students[classNum] = [];
        }
        
        // ユーザーの要望により氏名（C列: data[i][2]）もリストに含める
        students[classNum].push({
          id: studentId,
          name: data[i][2] ? data[i][2].toString().trim() : ""
        });
      }
      
      // 出席番号順にソート
      for (var classNum in students) {
        students[classNum].sort(function(a, b) {
          return a.id - b.id;
        });
      }
      
      return ContentService.createTextOutput(JSON.stringify({ status: "success", data: students }))
        .setMimeType(ContentService.MimeType.JSON);
        
    } else if (action === "login") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      var password = params.password ? params.password.toString().trim() : "";
      
      var data = sheet.getDataRange().getValues();
      var studentName = null;
      var authSuccess = false;
      var savedData = null;
      
      // 名簿照合 (A列=クラス, B列=出席番号, C列=氏名, D列=パスワード)
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          studentName = data[i][2] ? data[i][2].toString().trim() : "";
          var dbPassword = data[i][3] ? data[i][3].toString().trim() : "";
          if (dbPassword === password) {
            authSuccess = true;
            
            // クラスの教師(99番)の設定データを取得
            var teacherSettings = null;
            for (var j = 1; j < data.length; j++) {
              if (normalizeClass(data[j][0]) == classNumber && (data[j][1] == 99 || data[j][1] == "99")) {
                teacherSettings = data[j][7] || null;
                break;
              }
            }

            // ログイン成功と同時に、同じ行 of のG列(本文)からデータを取得してロードする
            savedData = {
              classNumber: data[i][0],
              studentId: data[i][1],
              studentName: studentName,
              charCount: data[i][5] || 0,
              text: data[i][6] || "",
              settings: teacherSettings // 教師の設定を優先適用
            };
          }
          break;
        }
      }
      
      if (!studentName) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "該当する児童が見つかりません" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
      if (!authSuccess) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "パスワードが正しくありません" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", 
        studentName: studentName,
        data: savedData
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "get_all_writings") {
      var classNumber = normalizeClass(params.classNumber);
      var data = sheet.getDataRange().getValues();
      var writings = [];
      
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber) {
          writings.push({
            studentId: data[i][1],
            studentName: data[i][2] ? data[i][2].toString().trim() : "",
            charCount: data[i][5] || 0,
            text: data[i][6] || "",
            settings: data[i][7] || null
          });
        }
      }
      
      return ContentService.createTextOutput(JSON.stringify({ status: "success", data: writings }))
        .setMimeType(ContentService.MimeType.JSON);

    } else if (action === "get_student_writing") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      var data = sheet.getDataRange().getValues();
      var result = null;
      
      // クラスの教師(99番)の設定データを取得
      var teacherSettings = null;
      for (var j = 1; j < data.length; j++) {
        if (normalizeClass(data[j][0]) == classNumber && (data[j][1] == 99 || data[j][1] == "99")) {
          teacherSettings = data[j][7] || null;
          break;
        }
      }

      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          result = {
            classNumber: data[i][0],
            studentId: data[i][1],
            studentName: data[i][2],
            charCount: data[i][5] || 0,
            text: data[i][6] || "",
            settings: teacherSettings // 教師の設定を優先適用
          };
          break;
        }
      }
      
      if (result) {
        return ContentService.createTextOutput(JSON.stringify({ status: "success", data: result }))
          .setMimeType(ContentService.MimeType.JSON);
      } else {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "データが見つかりません" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
  } catch(error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function normalizeClass(classStr) {
  if (!classStr) return "";
  return classStr.toString().trim()
    .replace(/[０-９]/g, function(s) {
      return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    })
    .replace(/[^0-9]/g, "");
}
