DFE_07 — LOCAL TESTING (OWN MODELS FOLDER + OPTIONAL ANIMATION)

Put these files directly alongside the files shown in your screenshot:
  DFE_07.xlsm
  DFE_07.json             <- export scene from Excel
  DFE_07_env.json         <- your environment file
  models/                 <- all referenced GLB models, including original ones
  DFE_local_server.py     <- this updated script
  Start_DFE_Windows.bat   <- double-click on Windows

The animation file DFE_07_anim.json is OPTIONAL. You do not need it yet.

1. Copy DFE_local_server.py and Start_DFE_Windows.bat from this kit to your
   EXISTING folder, replacing the earlier copies. Leave your other files in place.
2. In Excel Assets, model 'file' entries should be bare filenames like
   ConveyorNew.glb or YourGantry.glb (and component selectors like
   YourGantry.glb#Carriage). Place those GLBs in models/.
   Full GitHub URLs in the Excel file will still load ONLINE, not locally.
3. Double-click Start_DFE_Windows.bat (Python 3 must be installed).
4. VEB.js opens using LOCAL:
     scene:   http://localhost:8765/DFE_07.json
     env:     http://localhost:8765/DFE_07_env.json
     models:  http://localhost:8765/models/
   No professor model repository is used by the launcher.
5. Edit Excel, Export Scene, overwrite DFE_07.json in the SAME folder,
   and refresh the VEB.js tab. This avoids GitHub and deployment waits.
6. WHEN YOU HAVE AN ANIMATION: export it as DFE_07_anim.json into this folder.
   Close and restart the .bat launcher ONCE, so the newly generated URL
   includes 'inputanim'. Subsequent edits to that animation only need a refresh.

IMPORTANT: Your scene must have ALL its GLB files in models/ (including
ConveyorNew.glb, Part.glb, Pick_and_Place_Robot.glb, Grid.glb,
Box_large.glb if those exact names are referenced).

The local server is restricted to your own computer (127.0.0.1). Browser
security settings may block HTTPS websites from accessing localhost HTTP
assets, even with CORS headers. If Chrome shows a CORS, mixed-content or
local-network error, check F12 > Console/Network. If the request cannot be
allowed, the robust alternative is to host VEB.js locally as well.

This is a DEV workflow. Continue to use your public GitHub Pages scene for
final presentation/submission. The model files must be legally redistributable
if you later upload them to a public repo.
