# Swooper Logbook Web App

A personal mobile-friendly web application for tracking skydiving jumps. Data can be stored in Google Spreadsheet for multiple device access and backup.

This vibe-coded app was conceived for swoopers to keep track on the number of jumps on their linesets.

The actual application can be accessed here: [https://gerardburnside.github.io/SwooperLogbookWebApp]

## Features
- 📱 Mobile-responsive design
- 🪂 Jump entry with location and equipment tracking
- 📊 Auto-incrementing jump numbers (configurable starting number)
- 🔧 **Equipment system** - Manage harnesses, canopies, and linesets (per canopy)
- 📊 **Component-level statistics** - Track usage by harness (logged jumps + pre-app harness count), canopy/lineset, and locations
- 💫 **Equipment archiving** - Archive canopies/linesets while preserving statistics
- 📍 **Drop zone statistics** - Track your most visited locations
- 📋 Google Sheets integration for data storage
- 🔄 Offline-capable with sync when online
- 📤 Export data to CSV
- ⚙️ Configurable settings

## Quick Start
1. Open `index.html` in a web browser
2. **Set up equipment**:
   - Go to Equipment tab → Harnesses to add your harness(es) (e.g., Javelin, Mutant)
   - Go to Canopies to add your canopies (e.g., Petra64, Petra68), each with one or more linesets (e.g., #1, #2)
3. **Log jumps**: On the Jumps tab, add a jump and select a canopy (lineset). If that canopy has an optional harness assigned under Equipment → Canopies, each jump stores that harness for statistics.
4. **View stats**: Check Statistics tab for component-level analytics
5. Optional: Configure Google Sheets integration for cloud backup and synchronization across devices

## Equipment Management

The app uses a three-component equipment system:

### **Components**
- **Harnesses**: Your harness/container systems (e.g., Javelin Odyssey, Mutant). Optional **previous jumps (pre-app)** count toward harness statistics together with jumps logged here that store a harness id (from the canopy assignment at log time).
- **Canopies**: Your parachutes (e.g., Petra64, Petra68, Sabre2 120), each with one or more linesets. You can optionally **assign a harness** to a canopy; when you log a jump on that canopy, the app saves the harness on the jump (snapshot), so you can move the canopy to another harness later without rewriting past jumps.
- **Linesets**: Attached to each canopy, numbered automatically (e.g., #1, #2, #3)

When logging a jump, you select a canopy (with the desired lineset). Harness is not chosen on the jump form; it comes from the canopy’s harness assignment at log time.

### **Archiving**
- Archive canopies when you stop using them
- Archived equipment won’t appear in the jump logging dropdown
- All statistics are preserved for archived equipment

### **Statistics**
- **Component level**: Track usage by canopy and lineset
- **Drop zones**: Your most visited locations

This system gives you detailed insights into your gear usage and helps track equipment lifecycles.

## Google Sheets Setup (Optional)
1. See `config/README.md` for detailed setup instructions
2. Copy `config/sheets-config.example.json` to `config/sheets-config.json`
3. Add your Google Sheets API credentials

## Free Hosting
This app can be hosted for free on:
- **GitHub Pages** (recommended)
- Netlify
- Vercel  
- Firebase Hosting

See `HOSTING.md` for detailed deployment instructions.

## Mobile Usage
Add to your phone's home screen:
1. Open the app in your mobile browser
2. Use "Add to Home Screen" option
3. Enjoy native app-like experience

## Data Storage
- **Local:** Data automatically saved to browser storage
- **Cloud:** Optional Google Sheets sync for backup
- **Export:** Download your data as CSV anytime

## Stack
- Frontend: HTML, CSS, JavaScript (Vanilla)
- Data Storage: LocalStorage + Google Sheets API
- PWA: Manifest + Service Worker for offline use

## Project Structure
```
├── index.html              # Main application
├── css/
│   └── style.css          # Responsive styling
├── js/
│   ├── app.js            # Main application logic
│   └── sheets.js         # Google Sheets integration
├── config/
│   ├── README.md         # Sheets setup guide
│   └── sheets-config.example.json
├── manifest.json         # PWA manifest
├── sw.js                # Service worker
├── HOSTING.md           # Deployment guide
└── README.md           # This file
```

## Contributing
This is a personal project, but feel free to fork and customize for your needs!

## License
Open source - use freely for personal projects.

## Privacy Policy and Terms of Service:
[https://gerardburnside.github.io/SwooperLogbookWebApp/privacy-policy.html]
