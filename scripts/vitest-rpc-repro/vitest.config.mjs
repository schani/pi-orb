export default {
  test: {
    include: ["fixture.mjs"],
    maxWorkers: 1,
    fileParallelism: false,
    reporters: ["default"],
  },
};
