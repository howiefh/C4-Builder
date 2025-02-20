#!/usr/bin/env node

const plantuml = require('node-plantuml');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const rimraf = require('rimraf');
const docsifyTemplate = require('./docsify.template.js');
const markdownpdf = require("markdown-pdf");

const cli = require('./cli');

const {
    encodeURIPath,
    makeDirectory,
    readFile,
    writeFile,
    urlTextFrom
} = require('./utils.js');

let GENERATE_MD = false;//
let GENERATE_PDF = false;
let GENERATE_WEBSITE = true;
let GENERATE_COMPLETE_MD_FILE = true;
let GENERATE_COMPLETE_PDF_FILE = false;
let GENERATE_LOCAL_IMAGES = false;

let ROOT_FOLDER = 'src';
let DIST_FOLDER = 'docs';

let PROJECT_NAME = 'My Project';
let REPO_NAME = '';
let HOMEPAGE_NAME = 'Overview';
let MD_FILE_NAME = 'README';
let WEB_FILE_NAME = 'HOME';
let WEB_THEME = '//unpkg.com/docsify/lib/themes/vue.css';
let INCLUDE_NAVIGATION = false; //applies to GENERATE_MD
let INCLUDE_BREADCRUMBS = true; //applies to GENERATE_MD, GENERATE_COMPLETE_MD_FILE, GENERATE_PDF, GENERATE_COMPLETE_PDF_FILE
let INCLUDE_TABLE_OF_CONTENTS = true; //applies to GENERATE_MD
let INCLUDE_LINK_TO_DIAGRAM = false; //applies to all
let PDF_CSS = path.join(__dirname, 'pdf.css');
let DIAGRAMS_ON_TOP = true;

let DIAGRAM_FORMAT = 'svg'; //applies to all

const plantUmlServerUrl = content => `https://www.plantuml.com/plantuml/svg/0/${urlTextFrom(content)}`;

/**
 * get name from folder
 * depends on: ROOT_FOLDER, HOMEPAGE_NAME
 */
const getFolderName = dir => {
    return dir === ROOT_FOLDER ? HOMEPAGE_NAME : path.parse(dir).name;
};

/**
 * builds the directory structure
 * depends on: DIST_FOLDER, ROOT_FOLDER
 */
const generateTree = async (dir) => {
    let tree = [];

    const build = async (dir, parent) => {
        let name = getFolderName(dir);
        let item = tree.find(x => x.dir === dir);
        if (!item) {
            item = {
                dir: dir,
                name: name,
                level: dir.split(path.sep).length,
                parent: parent,
                mdFiles: [],
                pumlFiles: [],
                descendants: []
            };
            tree.push(item);
        }

        let files = fs.readdirSync(dir).filter(x => x.charAt(0) !== '_');
        for (const file of files) {
            //if folder
            if (fs.statSync(path.join(dir, file)).isDirectory()) {
                item.descendants.push(file);
                //create corresponding dist folder
                if (GENERATE_WEBSITE || GENERATE_MD || GENERATE_PDF || GENERATE_LOCAL_IMAGES)
                    await makeDirectory(path.join(DIST_FOLDER, dir.replace(ROOT_FOLDER, ''), file));

                await build(path.join(dir, file), dir);
            }
        }

        const mdFiles = files.filter(x => path.extname(x).toLowerCase() === '.md');
        for (const mdFile of mdFiles) {
            const fileContents = await readFile(path.join(dir, mdFile));
            item.mdFiles.push(fileContents);
        }
        const pumlFiles = files.filter(x => path.extname(x).toLowerCase() === '.puml');
        for (const pumlFile of pumlFiles) {
            const fileContents = await readFile(path.join(dir, pumlFile));
            item.pumlFiles.push({ dir: pumlFile, content: fileContents });
        }
    };

    await build(dir);

    return tree;
};

/**
 * transforms the puml files into images on disk
 * depends on: DIST_FOLDER, ROOT_FOLDER
 */
const generateImages = async (tree, onImageGenerated) => {
    let imagePromises = [];
    let totalImages = 0;
    let processedImages = 0;

    for (const item of tree) {
        let files = fs.readdirSync(item.dir).filter(x => x.charAt(0) !== '_');
        const pumlFiles = files.filter(x => path.extname(x).toLowerCase() === '.puml');
        for (const pumlFile of pumlFiles) {
            //write diagram as image
            let stream = fs.createWriteStream(
                path.join(
                    DIST_FOLDER,
                    item.dir.replace(ROOT_FOLDER, ''),
                    `${path.parse(pumlFile).name}.${DIAGRAM_FORMAT}`
                )
            );
            plantuml
                .generate(path.join(item.dir, pumlFile), { format: DIAGRAM_FORMAT })
                .out
                .pipe(stream);
            totalImages++;

            imagePromises.push(new Promise(resolve => stream.on('finish', resolve)).then(() => {
                processedImages++;
                if (onImageGenerated)
                    onImageGenerated(processedImages, totalImages);
            }));
        }
    }

    return Promise.all(imagePromises);
};

const generateCompleteMD = async (tree) => {
    let filePromises = [];

    //title
    let MD = `# ${PROJECT_NAME}`;
    //table of contents
    let tableOfContents = '';
    for (const item of tree)
        tableOfContents += `${'  '.repeat(item.level - 1)}* [${item.name}](#${encodeURIPath(item.name).replace(/%20/g, '-')})\n`;
    MD += `\n\n${tableOfContents}\n---`;

    for (const item of tree) {
        let name = getFolderName(item.dir);

        //title
        MD += `\n\n## ${name}`;
        if (name !== HOMEPAGE_NAME) {
            if (INCLUDE_BREADCRUMBS)
                MD += `\n\n\`${item.dir.replace(ROOT_FOLDER, '')}\``;
            MD += `\n\n[${HOMEPAGE_NAME}](#${encodeURIPath(PROJECT_NAME).replace(/%20/g, '-')})`;
        }

        //concatenate markdown files
        const appendText = () => {
            for (const mdFile of item.mdFiles) {
                MD += '\n\n';
                MD += mdFile;
            }
        };
        //add diagrams
        const appendImages = () => {
            for (const pumlFile of item.pumlFiles) {
                MD += '\n\n';
                let diagramUrl = encodeURIPath(path.join(
                    '.',
                    item.dir.replace(ROOT_FOLDER, ''),
                    path.parse(pumlFile.dir).name + `.${DIAGRAM_FORMAT}`
                ));
                if (!GENERATE_LOCAL_IMAGES)
                    diagramUrl = plantUmlServerUrl(pumlFile.content);

                let diagramImage = `![diagram](${diagramUrl})`;
                let diagramLink = `[Go to ${path.parse(pumlFile.dir).name} diagram](${diagramUrl})`;

                if (!INCLUDE_LINK_TO_DIAGRAM) //img
                    MD += diagramImage;
                else //link
                    MD += diagramLink;
            }
        };

        if (DIAGRAMS_ON_TOP) {
            appendImages();
            appendText();
        } else {
            appendText();
            appendImages();
        }
    }

    //write file to disk
    filePromises.push(writeFile(path.join(
        DIST_FOLDER,
        `${PROJECT_NAME}.md`
    ), MD));

    return Promise.all(filePromises);
};

const generateCompletePDF = async (tree) => {
    //title
    let MD = `# ${PROJECT_NAME}`;
    //table of contents
    let tableOfContents = '';
    for (const item of tree)
        tableOfContents += `${'  '.repeat(item.level - 1)}* ${item.name}\n`;
    MD += `\n\n${tableOfContents}\n---`;

    for (const item of tree) {
        let name = getFolderName(item.dir);

        //title
        MD += `\n\n## ${name}`;
        //bradcrumbs
        if (name !== HOMEPAGE_NAME) {
            if (INCLUDE_BREADCRUMBS)
                MD += `\n\n\`${item.dir.replace(ROOT_FOLDER, '')}\``;
        }

        //concatenate markdown files
        const appendText = () => {
            for (const mdFile of item.mdFiles) {
                MD += '\n\n';
                MD += mdFile;
            }
        };
        //add diagrams
        const appendImages = () => {
            for (const pumlFile of item.pumlFiles) {
                MD += '\n\n';
                let diagramUrl = encodeURIPath(path.join(
                    DIST_FOLDER,
                    item.dir.replace(ROOT_FOLDER, ''),
                    path.parse(pumlFile.dir).name + `.${DIAGRAM_FORMAT}`
                ));
                if (!GENERATE_LOCAL_IMAGES)
                    diagramUrl = plantUmlServerUrl(pumlFile.content);

                let diagramImage = `![diagram](${diagramUrl})`;

                MD += diagramImage;
            }
        };

        if (DIAGRAMS_ON_TOP) {
            appendImages();
            appendText();
        } else {
            appendText();
            appendImages();
        }
    }

    //write temp file
    await writeFile(path.join(
        DIST_FOLDER,
        `${PROJECT_NAME}_TEMP.md`
    ), MD);
    let stream = fs.createWriteStream(path.join(
        DIST_FOLDER,
        `${PROJECT_NAME}.pdf`
    ));
    //pdf
    fs.createReadStream(path.join(
        DIST_FOLDER,
        `${PROJECT_NAME}_TEMP.md`
    )).pipe(markdownpdf({
        paperFormat: 'A4',
        cssPath: PDF_CSS
    })).pipe(stream);

    await new Promise(resolve => stream.on('finish', resolve));

    //remove temp file
    rimraf.sync(path.join(
        DIST_FOLDER,
        `${PROJECT_NAME}_TEMP.md`
    ));
};

const generateMD = async (tree, onProgress) => {
    let processedCount = 0;
    let totalCount = 0;

    let filePromises = [];
    for (const item of tree) {
        let name = getFolderName(item.dir);
        //title
        let MD = `# ${name}`;
        //bradcrumbs
        if (INCLUDE_BREADCRUMBS && name !== HOMEPAGE_NAME)
            MD += `\n\n\`${item.dir.replace(ROOT_FOLDER, '')}\``;
        //table of contents
        if (INCLUDE_TABLE_OF_CONTENTS) {
            let tableOfContents = '';
            for (const _item of tree) {
                let label = `${item.dir === _item.dir ? '**' : ''}${_item.name}${item.dir === _item.dir ? '**' : ''}`
                tableOfContents += `${'  '.repeat(_item.level - 1)}* [${label}](${encodeURIPath(path.join(
                    '/',
                    DIST_FOLDER,
                    _item.dir.replace(ROOT_FOLDER, ''),
                    `${MD_FILE_NAME}.md`
                ))})\n`;
            }
            MD += `\n\n${tableOfContents}\n---`;
        }
        //parent menu
        if (item.parent && INCLUDE_NAVIGATION) {
            let parentName = getFolderName(item.parent);
            MD += `\n\n[${parentName} (up)](${encodeURIPath(path.join(
                '/',
                DIST_FOLDER,
                item.parent.replace(ROOT_FOLDER, ''),
                `${MD_FILE_NAME}.md`
            ))})`;
        }

        //exclude files and folders prefixed with _
        let descendantsMenu = '';
        for (const file of item.descendants) {
            descendantsMenu += `\n\n- [${file}](${encodeURIPath(path.join(
                '/',
                DIST_FOLDER,
                item.dir.replace(ROOT_FOLDER, ''),
                file,
                `${MD_FILE_NAME}.md`
            ))})`;
        }
        //descendants menu
        if (descendantsMenu && INCLUDE_NAVIGATION)
            MD += `${descendantsMenu}`;
        //separator
        if (INCLUDE_NAVIGATION)
            MD += `\n\n---`;

        //concatenate markdown files
        const appendText = () => {
            for (const mdFile of item.mdFiles) {
                MD += '\n\n';
                MD += mdFile;
            }
        };
        //add diagrams
        const appendImages = () => {
            for (const pumlFile of item.pumlFiles) {
                MD += '\n\n';
                let diagramUrl = encodeURIPath(path.join(
                    path.dirname(pumlFile.dir),
                    path.parse(pumlFile.dir).name + `.${DIAGRAM_FORMAT}`
                ));
                if (!GENERATE_LOCAL_IMAGES)
                    diagramUrl = plantUmlServerUrl(pumlFile.content);

                let diagramImage = `![diagram](${diagramUrl})`;
                let diagramLink = `[Go to ${path.parse(pumlFile.dir).name} diagram](${diagramUrl})`;

                if (!INCLUDE_LINK_TO_DIAGRAM) //img
                    MD += diagramImage;
                else //link
                    MD += diagramLink;
            }
        };

        if (DIAGRAMS_ON_TOP) {
            appendImages();
            appendText();
        } else {
            appendText();
            appendImages();
        }

        //write to disk
        totalCount++;
        filePromises.push(writeFile(path.join(
            DIST_FOLDER,
            item.dir.replace(ROOT_FOLDER, ''),
            `${MD_FILE_NAME}.md`
        ), MD).then(() => {
            processedCount++;
            if (onProgress)
                onProgress(processedCount, totalCount);
        }));
    }

    return Promise.all(filePromises);
};

const generatePDF = async (tree, onProgress) => {
    let processedCount = 0;
    let totalCount = 0;

    let filePromises = [];
    for (const item of tree) {
        let name = getFolderName(item.dir);
        //title
        let MD = `# ${name}`;
        if (INCLUDE_BREADCRUMBS && name !== HOMEPAGE_NAME)
            MD += `\n\n\`${item.dir.replace(ROOT_FOLDER, '')}\``;

        //concatenate markdown files
        const appendText = () => {
            for (const mdFile of item.mdFiles) {
                MD += '\n\n';
                MD += mdFile;
            }
        };
        //add diagrams
        const appendImages = () => {
            for (const pumlFile of item.pumlFiles) {
                MD += '\n\n';
                let diagramUrl = encodeURIPath(path.join(
                    DIST_FOLDER,
                    item.dir.replace(ROOT_FOLDER, ''),
                    path.parse(pumlFile.dir).name + `.${DIAGRAM_FORMAT}`
                ));
                if (!GENERATE_LOCAL_IMAGES)
                    diagramUrl = `https://www.plantuml.com/plantuml/png/0/${urlTextFrom(pumlFile.content)}`;

                let diagramImage = `![diagram](${diagramUrl})`;

                MD += diagramImage;
            }
        };

        if (DIAGRAMS_ON_TOP) {
            appendImages();
            appendText();
        } else {
            appendText();
            appendImages();
        }

        totalCount++;
        //write temp file
        filePromises.push(writeFile(path.join(
            DIST_FOLDER,
            item.dir.replace(ROOT_FOLDER, ''),
            `${MD_FILE_NAME}_TEMP.md`
        ), MD).then(() => {
            let stream = fs.createWriteStream(path.join(
                DIST_FOLDER,
                item.dir.replace(ROOT_FOLDER, ''),
                `${MD_FILE_NAME}.pdf`
            ));
            //pdf
            fs.createReadStream(path.join(
                DIST_FOLDER,
                item.dir.replace(ROOT_FOLDER, ''),
                `${MD_FILE_NAME}_TEMP.md`
            )).pipe(markdownpdf({
                paperFormat: 'A4',
                cssPath: PDF_CSS
            })).pipe(stream);

            return new Promise(resolve => stream.on('finish', resolve));
        }).then(() => {
            //remove temp file
            rimraf.sync(path.join(
                DIST_FOLDER,
                item.dir.replace(ROOT_FOLDER, ''),
                `${MD_FILE_NAME}_TEMP.md`
            ));
        }).then(() => {
            processedCount++;
            if (onProgress)
                onProgress(processedCount, totalCount);
        }));
    }

    return Promise.all(filePromises);
};

const generateWebMD = async (tree) => {
    let filePromises = [];
    let docsifySideBar = '';

    for (const item of tree) {
        //sidebar
        docsifySideBar += `${'  '.repeat(item.level - 1)}* [${item.name}](${encodeURIPath(path.join(...path.join(item.dir).split(path.sep).splice(1), WEB_FILE_NAME))})\n`;
        let name = getFolderName(item.dir);

        //title
        let MD = `# ${name}`;

        //concatenate markdown files
        const appendText = () => {
            for (const mdFile of item.mdFiles) {
                MD += '\n\n';
                MD += mdFile;
            }
        };
        //add diagrams
        const appendImages = () => {
            for (const pumlFile of item.pumlFiles) {
                MD += '\n\n';

                let diagramUrl = encodeURIPath(path.join(
                    path.dirname(pumlFile.dir),
                    path.parse(pumlFile.dir).name + `.${DIAGRAM_FORMAT}`
                ));
                if (!GENERATE_LOCAL_IMAGES)
                    diagramUrl = plantUmlServerUrl(pumlFile.content);

                let diagramImage = `![diagram](${diagramUrl})`;
                let diagramLink = `[Go to ${path.parse(pumlFile.dir).name} diagram](${diagramUrl})`;

                if (!INCLUDE_LINK_TO_DIAGRAM) //img
                    MD += diagramImage;
                else if (INCLUDE_LINK_TO_DIAGRAM && GENERATE_LOCAL_IMAGES)
                    MD += diagramImage;
                else //link
                    MD += diagramLink;
            }
        };

        if (DIAGRAMS_ON_TOP) {
            appendImages();
            appendText();
        } else {
            appendText();
            appendImages();
        }

        //write to disk
        filePromises.push(writeFile(path.join(
            DIST_FOLDER,
            item.dir.replace(ROOT_FOLDER, ''),
            `${WEB_FILE_NAME}.md`
        ), MD));
    }

    //docsify homepage
    filePromises.push(writeFile(path.join(
        DIST_FOLDER,
        `index.html`
    ), docsifyTemplate({
        name: PROJECT_NAME,
        repo: REPO_NAME,
        loadSidebar: true,
        auto2top: true,
        homepage: `${WEB_FILE_NAME}.md`,
        plantuml: {
            skin: 'classic'
        },
        stylesheet: WEB_THEME
    })));

    //github pages preparation
    filePromises.push(writeFile(path.join(
        DIST_FOLDER,
        `.nojekyll`
    ), ''));

    //sidebar
    filePromises.push(writeFile(path.join(
        DIST_FOLDER,
        '_sidebar.md'
    ), docsifySideBar));

    return Promise.all(filePromises);
};

const build = async () => {
    let start_date = new Date();

    //clear dist directory
    rimraf.sync(DIST_FOLDER);
    await makeDirectory(path.join(DIST_FOLDER));

    //actual build
    console.log(chalk.green(`\nbuilding documentation in ./${DIST_FOLDER}`));
    let tree = await generateTree(ROOT_FOLDER);
    console.log(chalk.blue(`parsed ${tree.length} folders`));
    if (GENERATE_LOCAL_IMAGES) {
        console.log(chalk.blue('generating images'));
        await generateImages(tree, (count, total) => {
            process.stdout.write(`processed ${count}/${total} images\r`);
        });
        console.log('');
    }
    if (GENERATE_MD) {
        console.log(chalk.blue('generating markdown files'));
        await generateMD(tree, (count, total) => {
            process.stdout.write(`processed ${count}/${total} files\r`);
        });
        console.log('');
    }
    if (GENERATE_WEBSITE) {
        console.log(chalk.blue('generating docsify site'));
        await generateWebMD(tree);
    }
    if (GENERATE_COMPLETE_MD_FILE) {
        console.log(chalk.blue('generating complete markdown file'));
        await generateCompleteMD(tree);
    }
    if (GENERATE_COMPLETE_PDF_FILE) {
        console.log(chalk.blue('generating complete pdf file'));
        await generateCompletePDF(tree);
    }
    if (GENERATE_PDF) {
        console.log(chalk.blue('generating pdf files'));
        await generatePDF(tree, (count, total) => {
            process.stdout.write(`processed ${count}/${total} files\r`);
        });
        console.log('');
    }

    console.log(chalk.green(`built in ${(new Date() - start_date) / 1000} seconds`));
    if (GENERATE_WEBSITE) {
        console.log(chalk.gray('\nto view the generated website run'));
        console.log(`> c4builder site`);
    }
};

//main
(async () => {
    let conf = await cli();
    if (!conf)
        return process.exit(0);

    ROOT_FOLDER = conf.get('rootFolder');
    DIST_FOLDER = conf.get('distFolder');
    PROJECT_NAME = conf.get('projectName');
    GENERATE_MD = conf.get('generateMD');
    INCLUDE_NAVIGATION = conf.get('includeNavigation');
    INCLUDE_TABLE_OF_CONTENTS = conf.get('includeTableOfContents');
    GENERATE_COMPLETE_MD_FILE = conf.get('generateCompleteMD');
    GENERATE_PDF = conf.get('generatePDF');
    GENERATE_COMPLETE_PDF_FILE = conf.get('generateCompletePDF');
    GENERATE_WEBSITE = conf.get('generateWEB');
    HOMEPAGE_NAME = conf.get('homepageName');
    GENERATE_LOCAL_IMAGES = conf.get('generateLocalImages');
    INCLUDE_LINK_TO_DIAGRAM = conf.get('includeLinkToDiagram');
    INCLUDE_BREADCRUMBS = conf.get('includeBreadcrumbs');
    WEB_THEME = conf.get('webTheme');
    REPO_NAME = conf.get('repoUrl');
    PDF_CSS = conf.get('pdfCss') || PDF_CSS;
    DIAGRAMS_ON_TOP = conf.get('diagramsOnTop');

    await build();

    return process.exit(0);
})();