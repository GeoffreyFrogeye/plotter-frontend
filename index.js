const express = require("express")
const bp = require("body-parser")
const app = express()
const { exec } = require("child_process");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const path = require("path");
const morgan = require("morgan");
const Validator = require("validatorjs");
const { nextTick } = require("process");

const validator = (body, rules, customMessages, callback) => {
  const validation = new Validator(body, rules, customMessages);
  validation.passes(() => callback(null, true));
  validation.fails(() => callback(validation.errors, false));
};

app.use("/static", express.static(path.join(__dirname, "public")));
app.use(bp.json())
app.use(express.urlencoded({extended: true}));
app.use(fileUpload({
    limits: {
        fileSize: 4 * 1024 * 1024 // 4 MB
    },
    abortOnLimit: true,
    createParentPath: true
}))
app.use(morgan("dev"))

// from https://github.com/expressjs/express/blob/2c47827053233e707536019a15499ccf5496dc9d/examples/route-map/index.js#L14
app.map = function(a, route){
  route = route || "";
  for (var key in a) {
    switch (typeof a[key]) {
      // { "/path": { ... }}
      case "object":
        app.map(a[key], route + key);
        break;
      // get: function(){ ... }
      case "function":
        console.log("adding route %s %s", key, route);
        app[key](route, a[key]);
        break;
    }
  }
};


app.param("sid", (req, res, next, sid) => {
  req.basePath = path.join(__dirname, "files", sid);
  req.sid = sid;
  fs.mkdir(req.basePath, { recursive: true }, (err) => {
    if (err) { return res.status(500).send("Internal server error"); }
    else { return next(); }
  });
})

const upload = (req, res) => {
  if (!req.files) {
    return res.status(400).send("No files were uploaded.");
  }
  const filename = req.files.file.name;
  const filepath = path.join(req.basePath, "image.svg");
  const extensionName = filename.substring(filename.length - 4); // fetch the file extension
  const allowedExtension = [".svg",".SVG"];
  if(!allowedExtension.includes(extensionName)){
    return res.status(422).send("Invalid Image");
  }

  req.files.file.mv(filepath, (err) => {
    if (err) {
      return res.status(500).send("Internal server error");
    } else {
      return res.send({ status: "success" });
    }
  });
}

const renderSVG = (req, res) => {
  let json = req.body
  validator(
    json,
    {
      // validation goes there
      "colors_only": "boolean",
      "color_key": "regex:/^(#[0-9a-fA-F]{6}\\s?)+$/",
      "scale": "required|numeric|min:0.1",
      "cut": "in:on",
      "hatch": "in:on",
      "hatch_density": "numeric|min:0.1",
    },
    {},
    (err, status) => {
      if (!status) {
        res.status(412).send(err);
      } else {
        let cmd = "./wild_driver_bin";
        cmd += " --json --input " + path.join(req.basePath, "image.svg");
        cmd += " --vis " + path.join(req.basePath, "vis.svg");

        if (json.colors_only) {
          cmd += " --colors_only"
        }

        console.log(json.color_key)
        if (json.color_key) {
          cmd += ` --color_key ${json.color_key.replace(/#/g, "\\#")} `
        }

        cmd += " --scale " + parseFloat(json.scale)

        if (json.cut) {
          cmd += " --cut"
        }
        if (json.hatch) {
          cmd += " --hatch"
        }
        if (json.hatch_density) {
          cmd += " --hatch_density " + parseFloat(json.hatch_density)
        }

        cmd += " --output " + req.basePath + "/"

        exec(cmd + "box.wild --box", (error, stdout, stderr) => {
          console.log("====== box ======\n")
          console.log(cmd + "box.wild --box\n")
          console.log(stdout)
          console.log(stderr)
          if (error) { return res.json({"success": false, "step": 1, "error": error}) }

          exec(cmd + "dry_run.wild --dry_run", (error, stdout, stderr) => {
              console.log("====== dry_run ======\n")
              console.log(cmd + "dry_run.wild --dry_run\n")
              console.log(stdout)
              console.log(stderr)
              if (error) { return res.json({"success": false, "step": 2, "error": error}) }

            exec(cmd + "draw.wild", (error, stdout, stderr) => {
                  console.log("====== draw ======\n")
                  console.log(cmd + "draw.wild\n")
                  console.log(stdout)
                  console.log(stderr)
                  if (error) { return res.json({"success": false, "step": 3, "error": error}) }

              return res.json({"success": true, "stdout": stdout})
            });
          });
        });
      }
    }
  )
}


// global state of the plotter (drawing)
let plotterReader = undefined;
let plotterWriter = undefined;
let plotterLastOutput = ""
let plotterAuthor = ""
let plotterSizeCur = 0;
let plotterSizeTotal = 1;
let plotterPaused = false;

const plotterPort = '/dev/ttyS0';

const plotterRun = (req, res) => {
  if(plotterReader !== undefined) { return res.status(409).send("Plotter busy"); }
  plotterReader = true;
  plotterAuthor = req.sid;
  plotterLastOutput = "preparing...";
  plotterSizeCur = 0;
  plotterSizeTotal = 1;

  let tgt = "";
  if(req.params.target === "box"){ tgt = "box.wild" }
  if(req.params.target === "dry_run"){ tgt = "dry_run.wild" }
  if(req.params.target === "draw"){ tgt = "draw.wild" }
  if(tgt === ""){ return res.status(404).send("Invalid endpoint") }

  let wildfile = path.join(req.basePath, tgt);
  let tempWildfile = path.join(__dirname, "files", "current_plot.wild");

  // Make a copy of the wildfile so we're sure nobody replace the drawing midway
  fs.copyFile(wildfile, tempWildfile, (err) => {
      if (err) {
          console.error("====== Error while copying ======");
          console.error(err);
          plotterReader = undefined;
          plotterLastOutput = "copy failed";
          res.status(500).send("Could not create temporary file");
          return;
      }
      // Read size of file
      try {
        plotterSizeTotal = fs.statSync(tempWildfile).size;
      } catch(err) {
        // If we don't get it we don't really care.
        console.warn(err);
      }

      // Configure serial port
      exec(`stty -F ${plotterPort} 9600 crtscts`, (err, stdout, stderr) => {
          if (err) {
              console.error(`====== Got code ${err.code} while running stty ======`);
              console.error(stdout);
              console.error(stderr);
              plotterReader = undefined;
              plotterLastOutput = "setup failed";
              res.status(500).send("Could not setup serial port");
              return;
          }

          // Open the copy and the port to be read one byte at a time
          // so it can be interrupted whenever
          plotterReader = fs.createReadStream(tempWildfile, {highWaterMark: 1});
          plotterWriter = fs.createWriteStream(plotterPort, {highWaterMark: 1});

          // When we read something
          plotterReader.on('data', (chunk) => {
              plotterSizeCur += chunk.length;
          });

          // For when errors happen
          plotterReader.on('error', (err) => {
              console.error("====== Error while reading ======");
              console.error(err);
              plotterLastOutput = "read failed";
              plotterReader.close();
          });

          plotterWriter.on('error', (err) => {
              console.error("====== Error while writing ======");
              console.error(err);
              plotterLastOutput = "write failed";
              plotterReader.close();
          });

          // For when the file is reached
          plotterReader.on('end', () => {
              plotterLastOutput = "success";
              plotterWriter.close();
          });

          // For when we stop writing
          // (either because of error, end reached, or stopped)
          plotterReader.on('close', () => {
              plotterReader = undefined;
              plotterWriter.close();
          });

          // Copy everything in the file to the plotter
          plotterReader.pipe(plotterWriter);
          plotterLastOutput = "printing...";

          // At this point the process should be started,
          // so we answer the HTTP call
          plotterAuthor = req.sid;
          res.send({status: "success"});
      });
  });
}

const plotterStatus = (req, res) => {
  return res.json({
    "busy": plotterReader !== undefined && plotterReader !== true,
    "last_output" : plotterLastOutput,
    "author": plotterAuthor,
    "sizeCur": plotterSizeCur,
    "sizeTotal": plotterSizeTotal,
    "paused": plotterPaused,
  });
}

const plotterPause = (req, res) => {
  if (plotterReader === undefined || plotterReader === true) {
    return res.status(409).send("Not running");
  }
  if (plotterPaused) {
    return res.status(409).send("Already paused");
  }
  plotterPaused = true;
  plotterLastOutput = "paused";
  plotterReader.unpipe();
  plotterReader.pause();
  return res.send({ status: "success" });
}

const plotterResume = (req, res) => {
  if (plotterReader === undefined || plotterReader === true) {
    return res.status(409).send("Not running");
  }
  if (!plotterPaused) {
    return res.status(409).send("Not paused");
  }
  plotterPaused = false;
  plotterLastOutput = "printing...";
  plotterReader.pipe(plotterWriter);
  return res.send({ status: "success" });
}

const plotterStop = (req, res) => {
  if (plotterReader === undefined || plotterReader === true) {
    return res.status(409).send("Not running");
  }
  plotterLastOutput = "stopped";
  plotterReader.close();
  return res.send({ status: "success" });
}


const randomID = () => {
  var length = 12;
  var chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz'.split('');
  var str = '';
  for (var i = 0; i < length; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}

app.map({
  "/": { get: (req, res) => { res.redirect(`/app/${randomID()}`); } },
  "/app/:sid([_a-zA-Z0-9]{1,32})": {
    get: (req, res) => { res.sendFile(path.join(__dirname, "html/index.html")); },

    "/original/:code?": { get: (req, res) => {
      res.setHeader("Content-Type", "image/svg+xml");
      res.sendFile(path.join(req.basePath, "image.svg"));
    } },

    "/preview/:code?": { get: (req, res) => {
      res.setHeader("Content-Type", "image/svg+xml");
      res.sendFile(path.join(req.basePath, "vis.svg"));
    } },
    "/upload": { post: upload },
    "/render_svg": { post: renderSVG },
    "/run/:target": { get: plotterRun }
  },
  "/plotter": {
    "/status": { get: plotterStatus }, // TODO: current session and filename
    "/stop": { get: plotterStop },
    "/pause": { get: plotterPause },
    "/resume": { get: plotterResume },
  }
})


const port = process.env.PORT || 8080

app.listen(port, "127.0.0.1", (err) => {
  if(err) throw err;
  console.log("listening on port " + port);
})
