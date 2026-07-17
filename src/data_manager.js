const fs = require('fs');
const path = require('path');
const { ClassicLevel } = require('classic-level');
const config = require('../config.json');

async function getAllWorldData() {
    console.log("--- DaDAA: Starting Data Extraction ---");
    const worldDataPath = config.foundryDataPath;
    const worldData = {};
    let loadedFromDb = false;
    
    if (worldDataPath && fs.existsSync(worldDataPath)) {
        try {
            const categories = fs.readdirSync(worldDataPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            for (const category of categories) {
                const categoryPath = path.join(worldDataPath, category);

                if (fs.existsSync(path.join(categoryPath, 'CURRENT'))) {
                    try {
                        const db = new ClassicLevel(categoryPath, { valueEncoding: 'json' });
                        const records = [];
                        
                        for await (const [key, value] of db.iterator()) {
                            records.push(value);
                        }
                        
                        worldData[category] = records;
                        await db.close();
                        loadedFromDb = true;
                    } catch (err) {
                        console.error(`  -> ERROR reading database at ${category}:`, err.message);
                    }
                } else {
                    console.log(`  -> Skipping (no LevelDB signature found).`);
                }
            }
        } catch (e) {
            console.error("-> Failed to read from Foundry directory:", e.message);
        }
    }

    if (!loadedFromDb) {
        console.log("-> Foundry LevelDB path not loaded. Falling back to reading JSON world data files from temp_data...");
        const tempDataPath = path.join(__dirname, '..', 'temp_data');
        if (fs.existsSync(tempDataPath)) {
            const tempFolders = ['actors', 'items', 'journal', 'tables', 'scenes', 'combats'];
            for (const folder of tempFolders) {
                const folderPath = path.join(tempDataPath, folder);
                if (fs.existsSync(folderPath)) {
                    try {
                        const files = fs.readdirSync(folderPath);
                        const records = [];
                        for (const file of files) {
                            if (file.endsWith('.json')) {
                                try {
                                    const filePath = path.join(folderPath, file);
                                    const content = fs.readFileSync(filePath, 'utf8');
                                    const record = JSON.parse(content);
                                    records.push(record);
                                } catch (e) {
                                    // ignore corrupt files
                                }
                            }
                        }
                        if (records.length > 0) {
                            worldData[folder] = records;
                        }
                    } catch (e) {
                        console.warn(`  -> Failed to read local folder temp_data/${folder}:`, e.message);
                    }
                }
            }
        }
    }
    
    console.log("--- DaDAA: Extraction Complete ---");
    return worldData;
}

module.exports = { getAllWorldData };