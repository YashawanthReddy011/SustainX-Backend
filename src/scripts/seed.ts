import { closeMongoDB, connectToMongoDB, getCollection } from "../config/db";
import { sdgs } from "../data/sdgs";

const sdgDetails: Record<number, { actions: string[]; targets: string[] }> = {
  1: { actions: ["Support local community initiatives", "Create skill development opportunities", "Promote financial awareness"], targets: ["Reduce poverty", "Build social protection", "Improve access to resources"] },
  4: { actions: ["Create peer-learning programs", "Develop educational resources", "Support digital literacy", "Mentor younger students"], targets: ["Quality learning", "Equal educational opportunity", "Lifelong learning"] },
  6: { actions: ["Organize water awareness campaigns", "Report water leakage", "Promote rainwater harvesting", "Reduce water wastage"], targets: ["Safe water access", "Water efficiency", "Sustainable water management"] },
  11: { actions: ["Report local civic issues", "Support clean public spaces", "Promote sustainable mobility", "Participate in community planning"], targets: ["Inclusive communities", "Safe public spaces", "Sustainable urban development"] },
  12: { actions: ["Run waste segregation campaigns", "Reduce single-use products", "Promote reuse and repair", "Track campus waste"], targets: ["Waste reduction", "Resource efficiency", "Responsible consumption"] },
  13: { actions: ["Organize climate awareness programs", "Measure carbon-conscious actions", "Promote public transport", "Plant and protect trees"], targets: ["Climate awareness", "Climate resilience", "Low-carbon actions"] },
  15: { actions: ["Plant native trees", "Create biodiversity records", "Protect local habitats", "Organize biodiversity awareness drives"], targets: ["Forest protection", "Biodiversity conservation", "Land restoration"] },
  17: { actions: ["Connect student organizations", "Collaborate with local communities", "Create cross-campus projects", "Share knowledge and resources"], targets: ["Multi-stakeholder partnerships", "Knowledge sharing", "Collaborative action"] },
};

async function main() {
  await connectToMongoDB();
  const collection = await getCollection("Sdg");

  for (const sdg of sdgs) {
    await collection.updateOne(
      { _id: sdg.id },
      {
        $set: {
          name: sdg.title,
          shortName: sdg.code,
          description: sdg.description ?? sdg.shortDescription,
          color: sdg.color ?? "#0f5132",
          actions: sdgDetails[sdg.id]?.actions ?? ["Learn about this goal", "Plan a local activity", "Share the results with your community"],
          targets: sdgDetails[sdg.id]?.targets ?? ["Build awareness", "Support local action", "Measure progress"],
        },
      },
      { upsert: true }
    );
  }

  const users = await getCollection("User");
  const demoUsers = [
    { _id: "demo-admin", name: "SustainX Admin", email: "admin@sustainx.local", role: "ADMIN" },
    { _id: "demo-student", name: "Yash Reddy", email: "student@sustainx.local", role: "STUDENT" },
    { _id: "demo-community", name: "Community Team", email: "community@sustainx.local", role: "COMMUNITY" },
  ];
  for (const user of demoUsers) {
    await users.updateOne(
      { _id: user._id },
      { $setOnInsert: { ...user, impactPoints: 0, status: "ACTIVE", createdAt: new Date() } },
      { upsert: true }
    );
  }

  const challenges = await getCollection("Challenge");
  const demoChallenges = [
    { _id: "green-campus-30", title: "30-Day Green Campus", description: "Make your campus greener through daily sustainable actions.", sdgId: 13, points: 500, participants: 128, durationDays: 30 },
    { _id: "water-saver", title: "Water Saver Challenge", description: "Identify and reduce unnecessary water consumption around you.", sdgId: 6, points: 350, participants: 74, durationDays: 21 },
    { _id: "plastic-free-week", title: "Plastic-Free Week", description: "Reduce single-use plastic and document your sustainable alternatives.", sdgId: 12, points: 300, participants: 95, durationDays: 7 },
    { _id: "biodiversity-hunt", title: "Campus Biodiversity Hunt", description: "Observe and document plants, birds and biodiversity in your area.", sdgId: 15, points: 450, participants: 61, durationDays: 14 },
  ];
  for (const challenge of demoChallenges) {
    await challenges.updateOne({ _id: challenge._id }, { $setOnInsert: { ...challenge, joinedUserIds: [], status: "ACTIVE", createdAt: new Date() } }, { upsert: true });
  }

  const projects = await getCollection("Project");
  const demoProjects = [
    { _id: "campus-tree-revival", title: "Campus Tree Revival", description: "A student-led project to restore green spaces through native tree plantation and maintenance.", sdgId: 15, members: 32, progress: 72, ownerName: "Yash Reddy" },
    { _id: "zero-waste-campus", title: "Zero Waste Campus", description: "Building better waste segregation and awareness systems across campus.", sdgId: 12, members: 24, progress: 58, ownerName: "Eco Club" },
    { _id: "every-drop-counts", title: "Every Drop Counts", description: "Water conservation awareness and leakage reporting initiative.", sdgId: 6, members: 19, progress: 81, ownerName: "Water Team" },
    { _id: "climate-learning-lab", title: "Climate Learning Lab", description: "Peer-led workshops that help students understand climate action.", sdgId: 13, members: 41, progress: 64, ownerName: "Green Campus" },
  ];
  for (const project of demoProjects) {
    await projects.updateOne({ _id: project._id }, { $setOnInsert: { ...project, ownerId: "demo-student", memberIds: [], status: "ACTIVE", createdAt: new Date() } }, { upsert: true });
  }

  const reports = await getCollection("CommunityReport");
  const demoReports = [
    { _id: "report-open-drainage", title: "Open drainage near community road", description: "An uncovered drain is creating a safety and sanitation concern for people walking along the road.", category: "Civic Infrastructure", location: "Local Ward", status: "IN_PROGRESS" },
    { _id: "report-plastic-park", title: "Plastic waste accumulation", description: "Single-use plastic waste has collected near the public park entrance.", category: "Waste Management", location: "Public Park", status: "REPORTED" },
    { _id: "report-street-light", title: "Broken street lighting", description: "The street light near the residential area has stopped working.", category: "Public Safety", location: "Residential Area", status: "RESOLVED" },
  ];
  for (const report of demoReports) {
    await reports.updateOne({ _id: report._id }, { $setOnInsert: { ...report, createdBy: "demo-community", createdAt: new Date() } }, { upsert: true });
  }

  console.log(`Seeded ${sdgs.length} SDGs, ${demoUsers.length} demo accounts, ${demoChallenges.length} challenges, ${demoProjects.length} projects and ${demoReports.length} community reports.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeMongoDB);
