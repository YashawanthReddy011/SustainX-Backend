import { getCollection } from "../config/db";

export async function ensureDatabaseIndexes() {
	await Promise.all([
		getCollection("User").then((collection) => Promise.all([
			collection.createIndex({ createdAt: -1 }, { name: "user_created" }),
			collection.createIndex({ status: 1, emailVerified: 1, impactPoints: -1, createdAt: 1 }, { name: "user_verified_leaderboard" }),
		])),
		getCollection("Activity").then((collection) => Promise.all([
			collection.createIndex({ userId: 1, createdAt: -1 }, { name: "activity_user_created" }),
			collection.createIndex({ status: 1, reviewedAt: -1, createdAt: -1 }, { name: "activity_status_reviewed" }),
			collection.createIndex({ sdgId: 1, status: 1, createdAt: -1 }, { name: "activity_sdg_status" }),
			collection.createIndex({ challengeId: 1, status: 1 }, { name: "activity_challenge_status" }),
			collection.createIndex({ projectId: 1, createdAt: -1 }, { name: "activity_project_created" }),
		])),
		getCollection("Challenge").then((collection) => Promise.all([
			collection.createIndex({ status: 1, createdAt: -1 }, { name: "challenge_status_created" }),
			collection.createIndex({ sdgId: 1, status: 1, createdAt: -1 }, { name: "challenge_sdg_status" }),
			collection.createIndex({ joinedUserIds: 1 }, { name: "challenge_members" }),
			collection.createIndex({ joinedUserIds: 1, createdAt: -1 }, { name: "challenge_member_created" }),
		])),
		getCollection("Project").then((collection) => Promise.all([
			collection.createIndex({ status: 1, createdAt: -1 }, { name: "project_status_created" }),
			collection.createIndex({ sdgNumbers: 1, status: 1, createdAt: -1 }, { name: "project_sdgs_status" }),
			collection.createIndex({ ownerId: 1, createdAt: -1 }, { name: "project_owner_created" }),
			collection.createIndex({ memberIds: 1 }, { name: "project_members" }),
		])),
		getCollection("CommunityReport").then((collection) => Promise.all([
			collection.createIndex({ status: 1, createdAt: -1 }, { name: "report_status_created" }),
			collection.createIndex({ category: 1, status: 1, createdAt: -1 }, { name: "report_category_status" }),
			collection.createIndex({ createdBy: 1, createdAt: -1 }, { name: "report_owner_created" }),
		])),
		getCollection("Notification").then((collection) => collection.createIndex({ userId: 1, createdAt: -1 }, { name: "notification_user_created" })),
		getCollection("Certificate").then((collection) => collection.createIndex({ userId: 1, issuedAt: -1 }, { name: "certificate_user_issued" })),
		getCollection("activitySubmissions").then((collection) => Promise.all([
			collection.createIndex({ userId: 1, submittedAt: -1 }, { name: "eco_submission_user_created" }),
			collection.createIndex({ status: 1, submittedAt: -1 }, { name: "eco_submission_status_created" }),
		])),
		getCollection("environmentalActivities").then((collection) => Promise.all([
			collection.createIndex({ type: 1, verifiedAt: -1 }, { name: "eco_activity_type_verified" }),
			collection.createIndex({ userId: 1, verifiedAt: -1 }, { name: "eco_activity_user_verified" }),
		])),
	]);
}
