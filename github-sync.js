#!/usr/bin/env node
const { Octokit } = require("@octokit/rest");


const argv = require('yargs/yargs')(process.argv.slice(2))
  .usage('Usage: $0 <command> [options]')
  .options({
    'source': {
      alias: 's',
      describe: 'source repository',
    },
    'base-url': {
      describe: 'base url of github api. Use source-base-url or target-base-url to set different base-urls for source and target',
      default: "https://api.github.com",
      demandOption: false
    },
    'source-base-url': {
      describe: 'base url of github api for the source repository',
      demandOption: false
    },
    'target-base-url': {
      describe: 'base url of github api for the target repositories',
      demandOption: false
    },
    'target': {
      alias: 't',
      array: true,
      describe: 'target repositories',
      demandOption: true
    },
    'token': {
      describe: 'github token. Use source-token or target-token to set different tokens for source and target',
      demandOption: false
    },
    'source-token': {
      describe: 'github token used for accessing source repository, if not provided falls back to token option or anonymous access',
      demandOption: false
    },
    'target-token': {
      describe: 'github token used for writing to target repositories, if not provided falls back to token option',
      demandOption: false
    },
    'list': {
      alias: 'l',
      array: true,
      describe: 'list of labels|milestones to sync; default: all'
    },
    'dry-run': {
      type: 'boolean',
      describe: 'log changes - do not write'
    },
    'update-only': {
      type: 'boolean',
      describe: 'do not create milestones/labels - only update existing'
    }

  })
  .example('$0 labels -s org/repo -t org2 -l "area/.*" stale --token github_token')
  .example('$0 milestones -s org/repo -t org/repo --target-base-url "https://github.example.com/api/v3" --target-token github_enterprise_token -l 1.18 1.19 1.20')
  .example('$0 labels -s org/repo -t org2 org3/repo --token github_personal_token')
  .example('$0 milestones -s org/repo -t org --dry-run')
  .example('$0 milestones -s org/repo -t org --update-only')
  .example('$0 delete-empty-milestones -t org')
  .command('labels', 'sync labels', {}, syncLabels)
  .command('milestones', 'sync milestones', {}, syncMilestones)
  .command('delete-empty-milestones', 'delete empty milestones (without issues)', {}, deleteEmptyMilestones)
  .demandCommand(1, 1, 'Command is missing')
  .strict()
  .wrap(null)
  .help()
  .argv

async function readSource(argv) {
  let octokit = new Octokit({ baseUrl: argv.sourceBaseUrl || argv.baseUrl, auth: argv.sourceToken || argv.token });
  let owner = argv.source.split('/')[0]
  let repo = argv.source.split('/')[1]
  let milestones = await octokit.paginate(octokit.issues.listMilestones, {
    owner,
    repo,
    state: 'all'
  });
  let labels = await octokit.paginate(octokit.issues.listLabelsForRepo, {
    owner,
    repo,
  });
  return { milestones, labels };
}

async function listRepos(octokit, org) {
  const data = await octokit.paginate(octokit.repos.listForOrg, {
    org
  });
  let repos = data.filter(r => !r.archived).map(r => { return { repo: r.name, owner: r.owner.login } })
  return repos;
}

async function readTargets(argv, octokit) {
  let targets = [];
  if (argv.target) {
    for (const t of argv.target) {
      if (t.indexOf('/') > 0) {
        targets.push({ owner: t.split('/')[0], repo: t.split('/')[1] });
      } else {
        let list = await listRepos(octokit, t);
        list.forEach(l => targets.push(l));
      }
    }
  }
  console.log("Target repositories: ")
  console.dir(targets)
  return targets
}
function filterByRegExpList(src, regExpList, field) {
  if (regExpList) {
    let filtered = src.filter(m => regExpList.some(name => new RegExp(name).test(m[field])))
    return filtered;
  }
  return src;
}

function equalMilestones(m1, m2) {
  if (m1.state != m2.state)
    return false;
  if (m1.description != m2.description)
    return false;
  if (m1.due_on && m2.due_on)
    return m1.due_on.substring(0, 10) == m2.due_on.substring(0, 10)
  return m1.due_on == m2.due_on;
}
function clean(obj) {
  for (var propName in obj) {
    if (obj[propName] === null || obj[propName] === undefined) {
      delete obj[propName];
    }
  }
  return obj
}
async function deleteEmptyMilestones(argv) {
  let octokit = new Octokit({ baseUrl: argv.targetBaseUrl || argv.baseUrl, auth: argv.targetToken || argv.token });
  let targets = await readTargets(argv, octokit);
  for (let t of targets) {
    let list = await octokit.paginate(octokit.issues.listMilestones, {
      owner: t.owner,
      repo: t.repo,
      state: 'all'
    });
    //console.log(JSON.stringify(list))
    let milestones = filterByRegExpList(list, argv.list, "title");
    for (let milestone of milestones) {
      if (milestone.state == 'closed' && milestone.open_issues == 0 && milestone.closed_issues == 0) {
        console.log("Delete closed and empty milestone: %s/%s %s", t.owner, t.repo, milestone.title)
        if (!argv.dryRun) {
          octokit.issues.deleteMilestone({
            owner: t.owner,
            repo: t.repo,
            milestone_number: milestone.number
          });
        }
      }
    }
  }
}

async function syncMilestones(argv) {
  let { milestones } = await readSource(argv);
  milestones = filterByRegExpList(milestones, argv.list, "title");
  console.log("Source milestones:")
  console.dir(milestones.map((m) => { return { title: m.title, description: m.description, due_on: m.due_on, state: m.state } }));

  let octokit = new Octokit({ baseUrl: argv.targetBaseUrl || argv.baseUrl, auth: argv.targetToken || argv.token });
  let targets = await readTargets(argv, octokit);

  for (let t of targets) {
    let list = await octokit.paginate(octokit.issues.listMilestones, {
      owner: t.owner,
      repo: t.repo,
      state: 'all'
    });
    for (let milestone of milestones) {
      let targetMilestone = list.find(item => item.title == milestone.title)
      if (targetMilestone) {
        if (milestone.state == 'closed' && targetMilestone.open_issues > 0) {
          console.log("Warning: milestone with open issues is closed! (%s/%s %s)", t.owner, t.repo, milestone.title);
        }
        if (equalMilestones(milestone, targetMilestone)) {
          console.log("Already up to date: %s/%s %s", t.owner, t.repo, milestone.title);
        } else {
          console.log("Update %s/%s %s: %s->%s, %s->%s, %s->%s", t.owner, t.repo, milestone.title,
            targetMilestone.due_on, milestone.due_on,
            targetMilestone.description, milestone.description,
            targetMilestone.state, milestone.state
          );
          if (!argv.dryRun) {
            octokit.issues.updateMilestone(clean({
              owner: t.owner,
              repo: t.repo,
              milestone_number: targetMilestone.number,
              due_on: milestone.due_on,
              description: milestone.description,
              state: milestone.state
            }));

          }
        }
      } else {
        if (!argv.updateOnly) {
          console.log("Create %s/%s %s", t.owner, t.repo, milestone.title);
          if (!argv.dryRun) {
            octokit.issues.createMilestone(clean({
              owner: t.owner,
              repo: t.repo,
              title: milestone.title,
              due_on: milestone.due_on,
              description: milestone.description
            }));
          }
        }
      }
    }
  }
}

async function syncLabels(argv) {
  let { labels } = await readSource(argv);
  labels = filterByRegExpList(labels, argv.list, "name")
  console.log("Source labels:");
  console.log(labels.map((l) => { return { name: l.name, description: l.description, color: l.color } }));

  let octokit = new Octokit({ baseUrl: argv.targetBaseUrl || argv.baseUrl, auth: argv.targetToken || argv.token });
  let targets = await readTargets(argv, octokit);

  for (let t of targets) {
    let labelList = await octokit.paginate(octokit.issues.listLabelsForRepo, {
      owner: t.owner,
      repo: t.repo
    });
    for (let label of labels) {
      let targetLabel = labelList.find(item => item.name == label.name)
      if (targetLabel) {
        if (targetLabel.color == label.color && targetLabel.description == label.description) {
          console.log("Label already up to date: %s/%s %s", t.owner, t.repo, label.name);
        } else {
          console.log("Update label %s/%s %s: %s->%s, %s->%s", t.owner, t.repo, label.name, targetLabel.color, label.color, targetLabel.description, label.description);
          if (!argv.dryRun) {
            octokit.issues.updateLabel({
              owner: t.owner,
              repo: t.repo,
              name: label.name,
              color: label.color,
              description: label.description
            });
          }
        }
      } else {
        if (!argv.updateOnly) {
          console.log("Create label %s/%s %s", t.owner, t.repo, label.name);
          if (!argv.dryRun) {
            octokit.issues.createLabel({
              owner: t.owner,
              repo: t.repo,
              name: label.name,
              color: label.color,
              description: label.description
            });
          }
        }
      }
    }

  }
}

